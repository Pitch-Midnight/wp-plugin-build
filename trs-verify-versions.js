/**
 * Shared version verifier for The Rite Sites plugin suite.
 *
 * WHY THIS EXISTS (2026-07-29)
 * ---------------------------------------------------------------------------
 * A WordPress plugin states its version in more than one place, and those
 * places drift. Measured across the suite on 2026-07-29:
 *
 *   cog-wc                        header 2.2.3, COG_WC_VERSION 2.2.3,
 *                                 package.json 2.2.2, Stable tag 2.2.1
 *   woocommerce-cost-of-shipping  header 1.5.4, const VERSION 1.5.3
 *                                 (and 1.5.4 SHIPPED that way)
 *   wc-net-profit                 header 2.1.1, package.json 2.1.0
 *
 * None of that is visible at build time, so it ships. This makes it fail
 * instead, and it lives here rather than in each workflow because the logic
 * kept growing and seven copies of a growing check is the same mistake as
 * five copies of zipping.config.js.
 *
 * AUTO-DISCOVERY, AND WHY
 * ---------------------------------------------------------------------------
 * The suite does not use one convention. Four plugins use
 * `define( 'X_VERSION', ... )`, one uses a class `const VERSION`, and two have
 * no constant at all - only the header. So rather than make every plugin
 * declare where its version lives (which is one more thing to get wrong), this
 * SCANS the declared files for every known way of writing a version down and
 * requires everything it finds to agree.
 *
 * The upside is that it catches constants nobody remembered were there. That
 * is exactly how the cost-of-shipping 1.5.3/1.5.4 split was found.
 *
 * WHAT IT CHECKS
 * ---------------------------------------------------------------------------
 *   HARD   plugin header `Version:`
 *   HARD   every version literal found in the scanned PHP files
 *   HARD   package.json `version`
 *   HARD   README changelog has an entry for the version, when a README exists
 *   HARD   README `Stable tag`, but ONLY when it holds a version - `trunk` is
 *          a wordpress.org SVN convention and is correct as-is
 *   HARD   the expected version passed in (the git tag), when given
 *
 * package.json is a HARD check here on purpose. It was warn-only earlier;
 * Parker's instruction 2026-07-29 is that the header, the plugin constant and
 * package.json must all be the same version, so a mismatch now fails.
 *
 * CONFIG, in the plugin's package.json:
 *
 *   "trsPackage": {
 *     "slug": "cog-wc",
 *     "mainFile": "trs-cost-of-goods-for-woocommerce.php",   // default <slug>.php
 *     "versionFiles": [ "includes/other.php" ],              // optional extras
 *     "versionConstants": [ "ADD_TO_CART_PRO" ],             // see below
 *     "readme": "README.txt"                                 // default README.txt
 *   }
 *
 * `versionConstants` exists because auto-discovery only finds constants whose
 * name ends in VERSION. add-to-cart-pro calls its version constant
 * `ADD_TO_CART_PRO`, so it was reported as having none while sitting in plain
 * sight - a false negative that would have passed a drifted constant. Declare
 * any such name here.
 *
 * USAGE, from the plugin directory:
 *
 *   node ../trs-verify-versions.js            # internal consistency only
 *   node ../trs-verify-versions.js 2.2.3      # also require this version
 */

'use strict';

const fs = require( 'fs' );
const path = require( 'path' );

/**
 * Ways a version gets written down in this suite. Each returns [value, label].
 *
 * Ordered most-specific first. `skip` marks patterns whose matches are known
 * not to be the plugin's own version.
 */
const PATTERNS = [
	{
		label: 'plugin header',
		re: /^[\s*#]*Version:\s*([0-9][^\s*]*)\s*$/gm,
		headerOnly: true,
	},
	{
		label: "define( '$1' )",
		re: /define\(\s*'([A-Z0-9_]*VERSION)'\s*,\s*'([0-9][^']*)'\s*\)/g,
		nameGroup: 1,
		valueGroup: 2,
	},
	{
		label: 'const VERSION',
		re: /\bconst\s+VERSION\s*=\s*'([0-9][^']*)'/g,
	},
	{
		label: '$version property',
		re: /\$version\s*=\s*'([0-9][^']*)'/g,
	},
];

/**
 * Constants that belong to vendored third-party code, not to the plugin.
 */
const IGNORED_NAMES = new Set( [ 'CMB2_VERSION' ] );

/**
 * Build a pattern matching `define( 'NAME', 'x.y.z' )` for explicitly named
 * constants.
 *
 * WHY THIS IS NEEDED. The auto-discovery above only matches constants whose
 * name ends in VERSION, which is the convention in four plugins. add-to-cart-pro
 * names its version constant `ADD_TO_CART_PRO` - no VERSION suffix at all - so
 * it was reported as "no version constant found" while sitting right there in
 * the main file. That is a FALSE NEGATIVE, and the dangerous kind: the check
 * would have passed a plugin whose version constant had silently drifted.
 *
 * Names are declared rather than inferred from "value looks like a version",
 * because that heuristic matches things that are not the plugin's version -
 * a minimum-PHP constant like define( 'X_MIN_PHP', '7.2' ) being the obvious
 * one. Explicit names cannot false-positive.
 *
 * @param {string} name Constant name.
 * @return {{label: string, re: RegExp}} Pattern entry.
 */
function namedConstantPattern( name ) {
	const escaped = name.replace( /[.*+?^${}()|[\]\\]/g, '\\$&' );

	return {
		label: `define( '${ name }' )`,
		re: new RegExp( `define\\(\\s*'${ escaped }'\\s*,\\s*'([0-9][^']*)'\\s*\\)`, 'g' ),
	};
}

/**
 * Find every version literal in one file.
 *
 * @param {string} file     Absolute path.
 * @param {boolean} isMain  Whether this is the main plugin file.
 * @param {string[]} [extraConstants] Additional constant names to look for.
 * @return {Array<{value: string, label: string, file: string, line: number}>} Findings.
 */
function scanFile( file, isMain, extraConstants = [] ) {
	const src = fs.readFileSync( file, 'utf8' );
	const rel = path.basename( file );
	const found = [];

	const patterns = [ ...PATTERNS, ...extraConstants.map( namedConstantPattern ) ];

	for ( const pattern of patterns ) {
		if ( pattern.headerOnly && ! isMain ) {
			continue;
		}

		const re = new RegExp( pattern.re.source, pattern.re.flags );
		let m;

		while ( ( m = re.exec( src ) ) !== null ) {
			const value = pattern.valueGroup ? m[ pattern.valueGroup ] : m[ 1 ];
			const name = pattern.nameGroup ? m[ pattern.nameGroup ] : null;

			if ( name && IGNORED_NAMES.has( name ) ) {
				continue;
			}

			// The header pattern must only ever match once, in the file header.
			// A "Version:" inside a changelog comment further down is not the
			// plugin's declared version.
			if ( pattern.headerOnly && found.some( ( f ) => f.label === 'plugin header' ) ) {
				continue;
			}

			found.push( {
				value,
				label: name ? `define( '${ name }' )` : pattern.label,
				file: rel,
				line: src.slice( 0, m.index ).split( '\n' ).length,
			} );
		}
	}

	return found;
}

/**
 * Verify every version statement for one plugin agrees.
 *
 * @param {string} [pluginDir]  Plugin working directory. Defaults to cwd.
 * @param {string} [expected]   Version that must match, e.g. from a git tag.
 * @return {{version: string, findings: Array, notes: string[]}} Result.
 * @throws {Error} On any disagreement, with every location listed.
 */
function verify( pluginDir = process.cwd(), expected = null ) {
	const root = path.resolve( pluginDir );
	const pkgPath = path.join( root, 'package.json' );
	const pkg = JSON.parse( fs.readFileSync( pkgPath, 'utf8' ) );
	const decl = pkg.trsPackage;

	if ( ! decl || ! decl.slug ) {
		throw new Error( '[trs-verify-versions] package.json needs a trsPackage block with a slug.' );
	}

	const mainFile = decl.mainFile || `${ decl.slug }.php`;
	const mainPath = path.join( root, mainFile );

	if ( ! fs.existsSync( mainPath ) ) {
		throw new Error(
			`[trs-verify-versions] main plugin file not found: ${ mainFile }\n` +
				`Set "trsPackage.mainFile" if it is not <slug>.php.`
		);
	}

	const extraConstants = decl.versionConstants || [];
	const findings = scanFile( mainPath, true, extraConstants );

	for ( const extra of decl.versionFiles || [] ) {
		const p = path.join( root, extra );
		if ( ! fs.existsSync( p ) ) {
			throw new Error( `[trs-verify-versions] versionFiles entry does not exist: ${ extra }` );
		}
		findings.push( ...scanFile( p, false, extraConstants ) );
	}

	if ( ! pkg.version ) {
		throw new Error( '[trs-verify-versions] package.json has no "version".' );
	}

	findings.push( { value: pkg.version, label: 'package.json version', file: 'package.json', line: 0 } );

	const header = findings.find( ( f ) => f.label === 'plugin header' );

	if ( ! header ) {
		throw new Error(
			`[trs-verify-versions] no "Version:" header found in ${ mainFile }. ` +
				'A WordPress plugin without one cannot be updated.'
		);
	}

	const notes = [];
	const constants = findings.filter(
		( f ) => f.label !== 'plugin header' && f.label !== 'package.json version'
	);

	if ( constants.length === 0 ) {
		notes.push(
			`no version constant found in ${ mainFile } - checking header and package.json only. ` +
				'If this plugin does have one under a name not ending in VERSION, declare it ' +
				'in trsPackage.versionConstants so it is checked.'
		);
	}

	// The header is the source of truth. Everything is compared to it.
	const truth = header.value;
	const disagree = findings.filter( ( f ) => f.value !== truth );

	if ( expected && expected !== truth ) {
		disagree.unshift( {
			value: expected,
			label: 'expected (git tag)',
			file: '-',
			line: 0,
		} );
	}

	// README checks. Only when a README actually exists - not every plugin
	// ships one, and a missing README is not a version defect.
	const readmeName = decl.readme || 'README.txt';
	const readmePath = path.join( root, readmeName );
	const readmeProblems = [];

	if ( fs.existsSync( readmePath ) ) {
		const readme = fs.readFileSync( readmePath, 'utf8' );
		const esc = truth.replace( /[.*+?^${}()|[\]\\]/g, '\\$&' );

		if ( ! new RegExp( `^=\\s*${ esc }\\s*=`, 'm' ).test( readme ) ) {
			readmeProblems.push( `${ readmeName } has no changelog entry "= ${ truth } ="` );
		}

		const stable = readme.match( /^Stable tag:\s*(\S+)\s*$/im );

		if ( stable ) {
			const value = stable[ 1 ];
			if ( value !== 'trunk' && value !== truth ) {
				readmeProblems.push(
					`${ readmeName } Stable tag is ${ value }, expected ${ truth } ` +
						'(on wordpress.org this decides what users download)'
				);
			} else if ( value === 'trunk' ) {
				notes.push( `${ readmeName } Stable tag is "trunk" - SVN convention, left alone` );
			}
		}
	} else {
		notes.push( `${ readmeName } not present - README checks skipped` );
	}

	if ( disagree.length || readmeProblems.length ) {
		const lines = [ `[trs-verify-versions] ${ decl.slug }: version statements disagree.`, '' ];
		lines.push( `  header (source of truth): ${ truth }  [${ header.file }:${ header.line }]` );
		lines.push( '' );

		for ( const f of findings.filter( ( x ) => x !== header ) ) {
			const mark = f.value === truth ? 'ok  ' : 'BAD ';
			const where = f.line ? `${ f.file }:${ f.line }` : f.file;
			lines.push( `  ${ mark } ${ f.value.padEnd( 12 ) } ${ f.label }  [${ where }]` );
		}

		for ( const f of disagree.filter( ( x ) => x.label === 'expected (git tag)' ) ) {
			lines.push( `  BAD  ${ f.value.padEnd( 12 ) } ${ f.label }` );
		}

		for ( const p of readmeProblems ) {
			lines.push( `  BAD  ${ p }` );
		}

		lines.push( '' );
		lines.push( '  The plugin header is the source of truth. Bring the others to it.' );

		throw new Error( lines.join( '\n' ) );
	}

	return { version: truth, findings, notes };
}

module.exports = { verify, scanFile };

if ( require.main === module ) {
	const expected = process.argv[ 2 ] || null;

	try {
		const { version, findings, notes } = verify( process.cwd(), expected );

		for ( const f of findings ) {
			const where = f.line ? `${ f.file }:${ f.line }` : f.file;
			process.stdout.write( `  ok   ${ version.padEnd( 12 ) } ${ f.label }  [${ where }]\n` );
		}

		for ( const n of notes ) {
			process.stdout.write( `  note ${ n }\n` );
		}

		process.stdout.write( `[trs-verify-versions] all version statements agree: ${ version }\n` );
	} catch ( err ) {
		process.stderr.write( `${ err.message }\n` );
		process.exit( 1 );
	}
}
