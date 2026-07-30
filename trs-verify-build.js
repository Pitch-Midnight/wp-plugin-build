/**
 * Build-integrity checks for The Rite Sites plugin suite.
 *
 * WHY THIS EXISTS (2026-07-30)
 * ---------------------------------------------------------------------------
 * Two defects on one day, both invisible to PHP tests and both cheap to catch
 * mechanically. This catches them.
 *
 * 1. wc-net-profit shipped an EVAL-DEVTOOL BUNDLE for two years.
 *
 *    webpack 5 defaults `mode: development` to devtool `eval`, wrapping every
 *    module in an eval() call. The plugin loads its non-minified bundle whenever
 *    WP_DEBUG is on, so only debug installs were affected - which meant
 *    production looked fine and nobody had a reason to look. It surfaced as a
 *    browser crash on the Analytics report the first time a genuinely fresh
 *    build reached a debug site.
 *
 * 2. add-to-cart-pro registered scripts and styles that were NOT IN THE PAYLOAD.
 *
 *    register_a2cp_group() read dist/blocks/a2cp-group.js and two CSS files
 *    under blocks/. dist/ is not produced by the current build and blocks/ is
 *    not in the release payload, so every admin page load emitted three
 *    filemtime() warnings and registered three URLs that 404.
 *
 * WHAT IT CHECKS, and the severity of each
 * ---------------------------------------------------------------------------
 *   FAIL  no bundle in the payload may be an eval-devtool build
 *   FAIL  every asset path written as a literal in the plugin's PHP must exist
 *         in the payload
 *   WARN  a bundle referencing a .map that is not in the payload - browsers
 *         request it, get the 404 page, and log a JSON parse error
 *
 * The asset check matches by path SUFFIX rather than exact position, because a
 * literal like 'assets/js/foo.js' is resolved by WordPress against a directory
 * the literal itself does not name. Suffix matching keeps that from producing
 * false alarms while still catching a file that is genuinely absent.
 *
 * Dynamic paths cannot be resolved from source - `filemtime( "$dir/$file" )` is
 * the shape that caused defect 2 - so those are invisible here. What IS caught
 * is the literal half, which is most of it.
 *
 * CONFIG, optional, in the plugin's package.json:
 *
 *   "trsPackage": {
 *     "buildChecks": {
 *       "allowMissingAssets": [ "blocks/a2cp-group/editor.css" ],
 *       "skipEvalCheck": false
 *     }
 *   }
 *
 * allowMissingAssets is an escape hatch for a genuinely optional asset. Prefer
 * fixing the reference or shipping the file; an entry here is a decision to
 * ship a broken reference on purpose, so say why in a comment beside it.
 *
 * USAGE, from the plugin directory, AFTER `npm run package`:
 *
 *   node ../trs-verify-build.js
 */

'use strict';

const fs = require( 'fs' );
const path = require( 'path' );

const STAGING_DIR = 'zip_files';

/**
 * Webpack's own banner when the eval devtool is in use. Matching the banner
 * rather than counting eval( calls, because minified third-party code contains
 * eval( legitimately and would produce constant false alarms.
 */
const EVAL_BANNER = /The "eval" devtool has been used/;

/**
 * Recursively list files under a directory.
 *
 * @param {string} dir  Directory to walk.
 * @param {string} base Prefix to strip for relative paths.
 * @return {string[]} Relative file paths.
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
 * Collect asset-looking path literals from the plugin's PHP.
 *
 * Only literals containing a slash are considered: a bare 'foo.js' is usually a
 * script HANDLE, not a path, and treating handles as paths is the fastest way
 * to make this check untrustworthy.
 *
 * @param {string} root Plugin directory.
 * @return {Map<string, string[]>} Asset path -> files that referenced it.
 */
function collectAssetReferences( root ) {
	const refs = new Map();
	const skipDirs = new Set( [ 'node_modules', 'vendor', 'cmb2', 'tests', STAGING_DIR, '.git' ] );
	const files = [];

	const walk = ( dir ) => {
		for ( const item of fs.readdirSync( dir, { withFileTypes: true } ) ) {
			if ( item.isDirectory() ) {
				if ( ! skipDirs.has( item.name ) ) {
					walk( path.join( dir, item.name ) );
				}
			} else if ( item.name.endsWith( '.php' ) ) {
				files.push( path.join( dir, item.name ) );
			}
		}
	};

	walk( root );

	if ( ! files.length ) {
		return refs;
	}

	// PHP's own tokenizer, not a regex over the raw source.
	//
	// The first version of this matched string literals with a regex and
	// immediately produced a false positive: wc-net-profit has a
	// plugins_url( '/build/wc-net-profit.js', ... ) call that is COMMENTED OUT,
	// and a regex cannot tell a live string from one inside `//`. A check that
	// reports problems which are not problems gets ignored, and an ignored check
	// is worse than no check.
	//
	// token_get_all understands comments, heredocs and escaping, so only real
	// string literals reach the match. PHP is guaranteed present - these are
	// WordPress plugins.
	const script = `
		$out = array();
		foreach ( array_slice( $argv, 1 ) as $file ) {
			$tokens = @token_get_all( file_get_contents( $file ) );
			if ( ! is_array( $tokens ) ) { continue; }
			foreach ( $tokens as $t ) {
				if ( ! is_array( $t ) || $t[0] !== T_CONSTANT_ENCAPSED_STRING ) { continue; }
				$val = substr( $t[1], 1, -1 );
				$out[] = $file . "\\t" . $val;
			}
		}
		echo implode( "\\n", $out );
	`;

	const { execFileSync } = require( 'child_process' );
	let raw = '';

	try {
		raw = execFileSync( 'php', [ '-r', script, ...files ], {
			encoding: 'utf8',
			maxBuffer: 64 * 1024 * 1024,
		} );
	} catch ( err ) {
		throw new Error(
			'[trs-verify-build] could not tokenize the plugin PHP: ' + err.message
		);
	}

	// Only literals containing a slash: a bare 'foo.js' is usually a script
	// HANDLE, and treating handles as paths would make this untrustworthy.
	const assetish = /^[A-Za-z0-9_./-]*\/[A-Za-z0-9_.-]+\.(?:js|css)$/;

	for ( const line of raw.split( '\n' ) ) {
		const tab = line.indexOf( '\t' );
		if ( tab === -1 ) {
			continue;
		}

		const file = line.slice( 0, tab );
		const value = line.slice( tab + 1 ).replace( /^\.?\//, '' );

		if ( ! assetish.test( value ) ) {
			continue;
		}

		// Minified variants are chosen at runtime by a file_exists() check, so
		// their absence is intentional rather than a defect.
		if ( /\.min\.(js|css)$/.test( value ) ) {
			continue;
		}

		if ( ! refs.has( value ) ) {
			refs.set( value, [] );
		}

		const rel = path.relative( root, file );
		if ( ! refs.get( value ).includes( rel ) ) {
			refs.get( value ).push( rel );
		}
	}

	return refs;
}

/**
 * Run every check against a staged payload.
 *
 * @param {string} [pluginDir] Plugin directory. Defaults to cwd.
 * @return {{failures: string[], warnings: string[], checked: Object}} Result.
 * @throws {Error} When nothing has been staged.
 */
function verify( pluginDir = process.cwd() ) {
	const root = path.resolve( pluginDir );
	const pkg = JSON.parse( fs.readFileSync( path.join( root, 'package.json' ), 'utf8' ) );
	const decl = pkg.trsPackage;

	if ( ! decl || ! decl.slug ) {
		throw new Error( '[trs-verify-build] package.json needs a trsPackage block with a slug.' );
	}

	const staged = path.join( root, STAGING_DIR, decl.slug );

	if ( ! fs.existsSync( staged ) ) {
		throw new Error(
			`[trs-verify-build] nothing staged at ${ STAGING_DIR }/${ decl.slug }.\n` +
				'Run `npm run package` first - these checks inspect the payload that ' +
				'would actually ship, not the working tree.'
		);
	}

	const opts = decl.buildChecks || {};
	const allowMissing = new Set( opts.allowMissingAssets || [] );
	const payload = listFiles( staged );
	const failures = [];
	const warnings = [];

	// ---- 1. No eval-devtool bundles. -------------------------------------
	let evalChecked = 0;

	if ( ! opts.skipEvalCheck ) {
		for ( const rel of payload.filter( ( f ) => f.endsWith( '.js' ) ) ) {
			const src = fs.readFileSync( path.join( staged, rel ), 'utf8' );
			evalChecked += 1;

			if ( EVAL_BANNER.test( src ) ) {
				failures.push(
					`${ rel } is an eval-devtool build.\n` +
						'      webpack wraps every module in eval() for devtool "eval", which is ' +
						'its\n      DEFAULT for mode: development. Set devtool explicitly in ' +
						'webpack.config.js.\n' +
						'      This only reaches installs that load the non-minified bundle ' +
						'(WP_DEBUG on),\n      which is exactly why it can go unnoticed for years.'
				);
			}
		}
	}

	// ---- 2. Referenced assets must be in the payload. --------------------
	const refs = collectAssetReferences( root );

	for ( const [ asset, sources ] of refs ) {
		if ( allowMissing.has( asset ) ) {
			continue;
		}

		const present = payload.some(
			( f ) => f === asset || f.endsWith( '/' + asset ) || f.endsWith( path.sep + asset )
		);

		if ( ! present ) {
			failures.push(
				`${ asset } is referenced but not in the payload.\n` +
					`      referenced by: ${ sources.slice( 0, 3 ).join( ', ' ) }\n` +
					'      WordPress will register a URL that 404s, and filemtime() on it ' +
					'warns.'
			);
		}
	}

	// ---- 3. Source maps referenced but not shipped. ----------------------
	for ( const rel of payload.filter( ( f ) => f.endsWith( '.js' ) ) ) {
		const src = fs.readFileSync( path.join( staged, rel ), 'utf8' );
		const m = src.match( /[#@]\s*sourceMappingURL=([^\s*]+)/ );

		if ( ! m || m[ 1 ].startsWith( 'data:' ) ) {
			continue;
		}

		const mapPath = path.posix.join( path.posix.dirname( rel.split( path.sep ).join( '/' ) ), m[ 1 ] );
		const present = payload.some( ( f ) => f.split( path.sep ).join( '/' ) === mapPath );

		if ( ! present ) {
			warnings.push(
				`${ rel } points at ${ m[ 1 ] }, which is not in the payload. ` +
					'The browser requests it, receives the 404 page, and logs a JSON parse error.'
			);
		}
	}

	return {
		failures,
		warnings,
		checked: { slug: decl.slug, payloadFiles: payload.length, jsFiles: evalChecked, assetRefs: refs.size },
	};
}

module.exports = { verify, collectAssetReferences };

if ( require.main === module ) {
	try {
		const { failures, warnings, checked } = verify();

		process.stdout.write(
			`[trs-verify-build] ${ checked.slug }: ${ checked.payloadFiles } files, ` +
				`${ checked.jsFiles } bundles, ${ checked.assetRefs } asset references\n`
		);

		for ( const w of warnings ) {
			process.stdout.write( `  warn  ${ w }\n` );
		}

		if ( failures.length ) {
			process.stderr.write( `\n[trs-verify-build] ${ failures.length } problem(s):\n\n` );
			for ( const f of failures ) {
				process.stderr.write( `  FAIL  ${ f }\n\n` );
			}
			process.exit( 1 );
		}

		process.stdout.write( '[trs-verify-build] payload looks sane\n' );
	} catch ( err ) {
		process.stderr.write( `${ err.message }\n` );
		process.exit( 1 );
	}
}
