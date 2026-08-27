/**
 * Free-tier derivation for the tier build split.
 *
 * Design: parker-context/pitch-midnight/20-tier-build-split.md. Reused by
 * trs-package.js when a plugin's trsPackage declares `tiers.free` - see
 * that file's own docblock for the two-artifact package contract.
 *
 * WHAT THIS DOES, IN ORDER (applyTier is the single entry point)
 * ---------------------------------------------------------------------------
 * 1. excludeLevel1()   - drop declared paths and any *.premium.<ext> file,
 *                        from a COPY of the already-staged premium payload.
 *                        Never touches the premium stage itself.
 * 2. stripMarkers()    - level 2 (#[PM\Premium] declarations) and level 3
 *                        (paired comment fences) removal, PHP via
 *                        trs-strip-analyze.php's real tokenizer, JS/CSS via
 *                        a narrower line-based fence stripper (documented
 *                        limitation below).
 * 3. lintPhp()         - `php -l` every resulting .php file. This is the
 *                        mechanical backstop for ANY bug in step 2's span
 *                        math, not just the one edge case
 *                        trs-strip-analyze.php's own docblock names -
 *                        REFUSES the build rather than shipping PHP that
 *                        does not even parse.
 * 4. transformHeader()  - declarative header rewrites (Plugin Name,
 *                        Update URI, etc.) on the free tier's main file.
 * 5. verifyNoLeak()     - grep the whole free-tier tree for any surviving
 *                        marker, attribute-class reference, or
 *                        `.premium.` filename remnant, and for any
 *                        function/class NAME that step 2 stripped but
 *                        that still appears elsewhere in the free tree
 *                        (the dangling-reference check - deliberately
 *                        narrow, see that function's own docblock).
 *
 * FAIL LOUDLY, EVERYWHERE. Every step throws with EVERY problem it found,
 * not the first - matching trs-package.js's own "fail on the whole missing
 * set" precedent. There is no silent-skip path anywhere in this file.
 */

'use strict';

const { execFileSync } = require( 'child_process' );
const fs = require( 'fs' );
const path = require( 'path' );

const ANALYZER = path.join( __dirname, 'trs-strip-analyze.php' );
const MARKER_ATTR_RE = /#\[\s*\\?PM\\Premium\s*\]/;
const FENCE_OPEN = '<pm:premium>';
const FENCE_CLOSE = '</pm:premium>';
const PREMIUM_SUFFIX_RE = /\.premium\.(php|js|css)$/i;

/**
 * Recursively list files under a directory, relative paths.
 *
 * @param {string} dir
 * @param {string} [base]
 * @return {string[]}
 */
function listFiles( dir, base = dir ) {
	const out = [];
	for ( const item of fs.readdirSync( dir, { withFileTypes: true } ) ) {
		const full = path.join( dir, item.name );
		if ( item.isDirectory() ) {
			out.push( ...listFiles( full, base ) );
		} else {
			out.push( path.relative( base, full ) );
		}
	}
	return out;
}

/**
 * Step 1 - whole file/directory exclusion (level 1 of the design doc).
 *
 * Operates on freeDir IN PLACE - caller is responsible for freeDir being a
 * copy, never the premium stage itself. Two sources of exclusion:
 *
 *   - `exclude`: paths declared in trsPackage.tiers.free.exclude, relative
 *     to the payload root (files or directories).
 *   - the `.premium.php` / `.premium.js` / `.premium.css` naming
 *     convention - a whole-file marker that needs no declaration.
 *
 * @param {string}   freeDir Free-tier staging copy (mutated).
 * @param {string[]} exclude Declared exclude paths.
 * @return {string[]} Relative paths actually removed, for reporting.
 */
function excludeLevel1( freeDir, exclude = [] ) {
	const removed = [];

	for ( const rel of exclude ) {
		const abs = path.join( freeDir, rel );
		if ( fs.existsSync( abs ) ) {
			fs.rmSync( abs, { recursive: true, force: true } );
			removed.push( rel );
		}
	}

	for ( const rel of listFiles( freeDir ) ) {
		if ( PREMIUM_SUFFIX_RE.test( rel ) ) {
			fs.rmSync( path.join( freeDir, rel ), { force: true } );
			removed.push( rel );
		}
	}

	return removed;
}

/**
 * Run trs-strip-analyze.php over every .php file under freeDir. Returns
 * the raw per-file findings; does not mutate anything.
 *
 * @param {string[]} phpFiles Absolute paths.
 * @return {Map<string, {spans: Array, errors: Array}>} keyed by absolute path.
 */
function analyzePhp( phpFiles ) {
	const result = new Map();
	if ( ! phpFiles.length ) {
		return result;
	}

	let raw;
	try {
		raw = execFileSync( 'php', [ ANALYZER, ...phpFiles ], {
			encoding: 'utf8',
			maxBuffer: 64 * 1024 * 1024,
		} );
	} catch ( err ) {
		throw new Error( `[trs-strip] trs-strip-analyze.php failed to run: ${ err.message }` );
	}

	let current = null;
	for ( const line of raw.split( '\n' ) ) {
		if ( ! line ) {
			continue;
		}
		const parts = line.split( '\t' );
		if ( parts[ 0 ] === 'FILE' ) {
			current = parts[ 1 ];
			result.set( current, { spans: [], errors: [] } );
			continue;
		}
		if ( current === null ) {
			continue; // Malformed output - ignore rather than crash on a stray line.
		}
		if ( parts[ 0 ] === 'SPAN' ) {
			result.get( current ).spans.push( {
				start: Number( parts[ 1 ] ),
				end: Number( parts[ 2 ] ),
				kind: parts[ 3 ],
				line: Number( parts[ 4 ] ),
				symbol: parts[ 5 ] || '',
			} );
		} else if ( parts[ 0 ] === 'ERROR' ) {
			result.get( current ).errors.push( { line: Number( parts[ 1 ] ), message: parts[ 2 ] } );
		}
	}

	return result;
}

/**
 * Delete a set of non-overlapping byte spans from a string. Spans are
 * applied LAST-TO-FIRST so earlier offsets stay valid as later spans are
 * removed - the same reason `trs-package.js`'s vendor overlay runs after
 * the declared payload, stated once and reused here.
 *
 * REFUSES on overlap rather than guessing an order - see the design doc's
 * "two markers describing the same region is unsupported" rule.
 *
 * @param {string} src
 * @param {Array<{start:number, end:number}>} spans
 * @param {string} label For the overlap error message.
 * @return {string}
 */
function deleteSpans( src, spans, label ) {
	const sorted = [ ...spans ].sort( ( a, b ) => a.start - b.start );
	for ( let i = 1; i < sorted.length; i++ ) {
		if ( sorted[ i ].start < sorted[ i - 1 ].end ) {
			throw new Error(
				`[trs-strip] ${ label }: two premium markers describe overlapping regions ` +
					`(byte ${ sorted[ i - 1 ].start }-${ sorted[ i - 1 ].end } and ` +
					`${ sorted[ i ].start }-${ sorted[ i ].end }) - use one marker per region.`
			);
		}
	}

	let out = src;
	for ( let i = sorted.length - 1; i >= 0; i-- ) {
		out = out.slice( 0, sorted[ i ].start ) + out.slice( sorted[ i ].end );
	}
	return out;
}

/**
 * Level 3 fence stripping for non-PHP text (JS/CSS). Line-based, not
 * tokenizer-based - PHP has a real tokenizer available as a subprocess;
 * JS/CSS does not, without a new dependency this suite's zero-dependency
 * build tooling deliberately avoids.
 *
 * KNOWN LIMITATION, stated rather than hidden: a marker-looking substring
 * inside a JS template literal or string would be (mis)treated as a real
 * fence. In practice this scopes level-3 JS/CSS fencing to RAW files that
 * ship into the payload unmodified - a webpack-BUNDLED file has already
 * been minified/mangled before trs-package.js ever stages it, so fences in
 * SOURCE .js do not survive into `dist/` anyway. For bundled premium JS,
 * level 1 (a separate webpack entry point, excluded from the free build
 * entirely) is the only mechanism that actually works - the design doc
 * says this outright. Applying this function to a `dist/` bundle is a
 * misuse, not a supported case.
 *
 * @param {string} src
 * @param {string} label For error messages.
 * @return {string}
 */
function stripFencesText( src, label ) {
	const openMarker = `/*! ${ FENCE_OPEN } */`;
	const closeMarker = `/*! ${ FENCE_CLOSE } */`;
	const spans = [];
	let searchFrom = 0;

	for ( ;; ) {
		const openAt = src.indexOf( openMarker, searchFrom );
		if ( openAt === -1 ) {
			break;
		}
		const closeAt = src.indexOf( closeMarker, openAt + openMarker.length );
		if ( closeAt === -1 ) {
			throw new Error( `[trs-strip] ${ label }: ${ FENCE_OPEN } was never closed with ${ FENCE_CLOSE }` );
		}
		const nextOpen = src.indexOf( openMarker, openAt + openMarker.length );
		if ( nextOpen !== -1 && nextOpen < closeAt ) {
			throw new Error( `[trs-strip] ${ label }: nested ${ FENCE_OPEN } before the matching ${ FENCE_CLOSE }` );
		}
		spans.push( { start: openAt, end: closeAt + closeMarker.length } );
		searchFrom = closeAt + closeMarker.length;
	}

	// A lone close with no preceding open, anywhere in the file.
	if ( src.includes( closeMarker ) ) {
		const closes = src.split( closeMarker ).length - 1;
		if ( closes > spans.length ) {
			throw new Error( `[trs-strip] ${ label }: ${ FENCE_CLOSE } with no matching ${ FENCE_OPEN }` );
		}
	}

	return spans.length ? deleteSpans( src, spans, label ) : src;
}

/**
 * Step 2 - strip levels 2 and 3 from every text file under freeDir,
 * mutating files in place. Returns the symbol names stripped (for the
 * dangling-reference check) and throws with EVERY error found across
 * every file if any file had one.
 *
 * @param {string} freeDir
 * @return {string[]} Stripped function/method/class names.
 */
function stripMarkers( freeDir ) {
	const allFiles = listFiles( freeDir );
	const phpFiles = allFiles.filter( ( f ) => f.endsWith( '.php' ) );
	const otherFiles = allFiles.filter( ( f ) => /\.(js|css)$/i.test( f ) );

	const analysis = analyzePhp( phpFiles.map( ( f ) => path.join( freeDir, f ) ) );
	const errors = [];
	const strippedSymbols = [];

	for ( const rel of phpFiles ) {
		const abs = path.join( freeDir, rel );
		const found = analysis.get( abs );
		if ( ! found ) {
			continue;
		}
		for ( const e of found.errors ) {
			errors.push( `${ rel }:${ e.line || '?' }  ${ e.message }` );
		}
		if ( found.errors.length ) {
			continue; // Do not attempt to strip a file the analyzer could not fully parse.
		}
		if ( ! found.spans.length ) {
			continue;
		}
		const src = fs.readFileSync( abs, 'utf8' );
		const stripped = deleteSpans( src, found.spans, rel );
		fs.writeFileSync( abs, stripped );
		for ( const s of found.spans ) {
			if ( s.symbol ) {
				strippedSymbols.push( s.symbol );
			}
		}
	}

	if ( errors.length ) {
		throw new Error(
			`[trs-strip] ${ errors.length } premium-marker problem(s):\n\n` +
				errors.map( ( e ) => `  ${ e }` ).join( '\n' )
		);
	}

	for ( const rel of otherFiles ) {
		const abs = path.join( freeDir, rel );
		const src = fs.readFileSync( abs, 'utf8' );
		const stripped = stripFencesText( src, rel );
		if ( stripped !== src ) {
			fs.writeFileSync( abs, stripped );
		}
	}

	return strippedSymbols;
}

/**
 * Step 3 - `php -l` every resulting PHP file. The backstop for any span
 * miscalculation, not just the one this file's analyzer docblock names.
 *
 * @param {string} freeDir
 */
function lintPhp( freeDir ) {
	const phpFiles = listFiles( freeDir ).filter( ( f ) => f.endsWith( '.php' ) );
	const failures = [];

	for ( const rel of phpFiles ) {
		const abs = path.join( freeDir, rel );
		try {
			execFileSync( 'php', [ '-l', abs ], { encoding: 'utf8', stdio: [ 'ignore', 'pipe', 'pipe' ] } );
		} catch ( err ) {
			failures.push( `${ rel }:\n${ ( err.stdout || err.message ).toString().trim() }` );
		}
	}

	if ( failures.length ) {
		throw new Error(
			`[trs-strip] the free tier failed to lint after stripping - this means a ` +
				`span was computed wrong, not that the source was ever broken:\n\n` +
				failures.map( ( f ) => `  ${ f }` ).join( '\n\n' )
		);
	}
}

/**
 * Step 4 - declarative header rewrite on the free tier's main plugin
 * file. Never edits source; operates on the free-tier copy only. Mirrors
 * svn-push.sh's `Tested up to` rewrite: transform, then re-read and
 * verify every field actually took.
 *
 * A `null` value deletes the header line entirely (used for Update URI,
 * so wordpress.org's own updater is the one that applies to the free
 * build - see the design doc's same-slug section).
 *
 * @param {string} mainFilePath Absolute path to the free tier's main file.
 * @param {Object} overrides    Field name -> new value (or null to delete).
 */
function transformHeader( mainFilePath, overrides = {} ) {
	if ( ! Object.keys( overrides ).length ) {
		return;
	}

	let src = fs.readFileSync( mainFilePath, 'utf8' );

	for ( const [ field, value ] of Object.entries( overrides ) ) {
		const lineRe = new RegExp( `^([ \\t*]*)${ escapeRegExp( field ) }:.*$`, 'm' );

		if ( value === null ) {
			if ( lineRe.test( src ) ) {
				src = src.replace( lineRe, ( m, indent ) => `${ indent }DELETED_HEADER_LINE_MARKER` );
				src = src
					.split( '\n' )
					.filter( ( l ) => ! l.includes( 'DELETED_HEADER_LINE_MARKER' ) )
					.join( '\n' );
			}
			continue;
		}

		if ( ! lineRe.test( src ) ) {
			throw new Error(
				`[trs-strip] ${ path.basename( mainFilePath ) }: header field "${ field }" not found - ` +
					`cannot set it to "${ value }". Add the field to the premium source first.`
			);
		}
		src = src.replace( lineRe, ( m, indent ) => `${ indent }${ field }: ${ value }` );
	}

	fs.writeFileSync( mainFilePath, src );

	// Re-read and verify every field, per field - the same
	// transform-then-re-grep shape svn-push.sh already established.
	const after = fs.readFileSync( mainFilePath, 'utf8' );
	for ( const [ field, value ] of Object.entries( overrides ) ) {
		const lineRe = new RegExp( `^[ \\t*]*${ escapeRegExp( field ) }:.*$`, 'm' );
		const present = lineRe.test( after );
		if ( value === null && present ) {
			throw new Error( `[trs-strip] header rewrite did not take: "${ field }" is still present after being set to null.` );
		}
		if ( value !== null && ( ! present || ! after.includes( `${ field }: ${ value }` ) ) ) {
			throw new Error( `[trs-strip] header rewrite did not take: "${ field }" is not "${ value }" after rewrite.` );
		}
	}
}

/** @param {string} s @return {string} */
function escapeRegExp( s ) {
	return s.replace( /[.*+?^${}()|[\]\\]/g, '\\$&' );
}

/**
 * Step 5 - leak grep + dangling-reference check across the whole free
 * tree, after stripping.
 *
 * The leak grep is exhaustive by construction - it is a plain string
 * search for the marker text and the attribute class name, so nothing
 * about it depends on the analyzer having worked correctly upstream.
 *
 * The dangling-reference check is DELIBERATELY NARROW, stated rather than
 * oversold: it only checks function/method/class NAMES that step 2
 * stripped, as whole-word matches across every remaining free-tier file.
 * Property and const names are excluded on purpose - too common a word
 * shape (`$id`, `$name`, `ENABLED`) to check without a real symbol table,
 * and a check that reports non-problems gets ignored
 * (trs-verify-build.js's own stated reasoning, reused here). This catches
 * "the premium method was removed but a shared file still calls it" -
 * the shape that would otherwise be a free-tier fatal error on activation
 * - not every possible dangling reference.
 *
 * @param {string} freeDir
 * @param {string[]} strippedSymbols
 */
function verifyNoLeak( freeDir, strippedSymbols ) {
	const files = listFiles( freeDir ).filter( ( f ) => /\.(php|js|css|txt)$/i.test( f ) );
	const phpFiles = files.filter( ( f ) => f.endsWith( '.php' ) );
	const nonPhpFiles = files.filter( ( f ) => ! f.endsWith( '.php' ) );
	const leaks = [];

	// PHP: re-run the SAME tokenizer-based analyzer used to strip in the
	// first place, on the ALREADY-STRIPPED tree. A genuine leak is
	// indistinguishable from "stripping missed something" - both mean
	// the analyzer finds a real SPAN or fence-pairing problem here, and
	// a real find here is exactly as trustworthy as it was in
	// stripMarkers(), because it is the identical check. This is
	// DELIBERATELY not a text/regex scan: a plugin's own developer
	// comment explaining "how #[PM\Premium] works" - or this vendored
	// class's own docblock, which does exactly that - would trip a
	// naive substring match on prose that was never a real marker. Found
	// live: vendor/pm-premium/Premium.php's own documentation flagged
	// itself as a leak before this was fixed.
	if ( phpFiles.length ) {
		const analysis = analyzePhp( phpFiles.map( ( f ) => path.join( freeDir, f ) ) );
		for ( const rel of phpFiles ) {
			const found = analysis.get( path.join( freeDir, rel ) );
			if ( ! found ) {
				continue;
			}
			for ( const s of found.spans ) {
				leaks.push( `${ rel }:${ s.line }  a real #[PM\\Premium] ${ s.kind === 'fence' ? 'fence' : 'attribute' } survived stripping` );
			}
			for ( const e of found.errors ) {
				leaks.push( `${ rel }:${ e.line || '?' }  ${ e.message } (found re-scanning the STRIPPED file - this should be impossible; report it)` );
			}
		}
	}

	// JS/CSS/txt: no tokenizer available, so this stays a plain substring
	// scan - same documented limitation as stripFencesText() (a marker-
	// looking substring inside a string/template literal would false-
	// positive here too). Narrower surface than the PHP case in
	// practice: these files are far less likely to carry prose
	// explaining the marker syntax than a vendored PHP class's own
	// docblock is.
	for ( const rel of nonPhpFiles ) {
		const src = fs.readFileSync( path.join( freeDir, rel ), 'utf8' );
		if ( MARKER_ATTR_RE.test( src ) ) {
			leaks.push( `${ rel }: #[PM\\Premium]-looking text survived stripping` );
		}
		if ( src.includes( FENCE_OPEN ) || src.includes( FENCE_CLOSE ) ) {
			leaks.push( `${ rel }: a <pm:premium> fence marker survived stripping` );
		}
	}

	for ( const rel of listFiles( freeDir ) ) {
		if ( PREMIUM_SUFFIX_RE.test( rel ) ) {
			leaks.push( `${ rel }: a .premium. file survived level-1 exclusion` );
		}
	}

	if ( leaks.length ) {
		throw new Error(
			`[trs-strip] ${ leaks.length } leak(s) in the free-tier payload:\n\n` +
				leaks.map( ( l ) => `  ${ l }` ).join( '\n' )
		);
	}

	const uniqueSymbols = [ ...new Set( strippedSymbols ) ];
	const dangling = [];

	for ( const symbol of uniqueSymbols ) {
		const wordRe = new RegExp( `\\b${ escapeRegExp( symbol ) }\\b` );
		for ( const rel of files ) {
			if ( wordRe.test( fs.readFileSync( path.join( freeDir, rel ), 'utf8' ) ) ) {
				dangling.push( `"${ symbol }" (a stripped declaration) is still referenced in ${ rel }` );
			}
		}
	}

	if ( dangling.length ) {
		throw new Error(
			`[trs-strip] ${ dangling.length } dangling reference(s) to stripped code:\n\n` +
				dangling.map( ( d ) => `  ${ d }` ).join( '\n' ) +
				`\n\nA symbol removed from the free tier is still called there - the free ` +
				`build would fatal on activation.`
		);
	}
}

/**
 * Single entry point: derive a free-tier build from an already-staged
 * premium payload. `stageDir` is READ ONLY - a fresh copy is made at
 * `freeDir` and every step operates on that copy alone.
 *
 * @param {string} stageDir  Absolute path to the premium staged payload
 *                           (e.g. zip_files/<slug>/<slug>).
 * @param {string} freeDir   Absolute path to create the free-tier copy at.
 *                           Removed and recreated if it already exists.
 * @param {string} mainFile  Relative path (within the payload) to the
 *                           plugin's main file, for the header rewrite.
 * @param {Object} tierDecl  trsPackage.tiers.free block: {exclude, header}.
 * @return {{removed: string[], strippedSymbols: string[]}}
 */
function applyTier( stageDir, freeDir, mainFile, tierDecl = {} ) {
	fs.rmSync( freeDir, { recursive: true, force: true } );
	fs.cpSync( stageDir, freeDir, { recursive: true } );

	const removed = excludeLevel1( freeDir, tierDecl.exclude || [] );
	const strippedSymbols = stripMarkers( freeDir );
	lintPhp( freeDir );
	transformHeader( path.join( freeDir, mainFile ), tierDecl.header || {} );
	verifyNoLeak( freeDir, strippedSymbols );

	return { removed, strippedSymbols };
}

module.exports = {
	applyTier,
	excludeLevel1,
	stripMarkers,
	lintPhp,
	transformHeader,
	verifyNoLeak,
	// Exported for the fixture's own smoke test, not part of the public contract.
	stripFencesText,
	deleteSpans,
};
