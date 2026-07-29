/**
 * Shared release packager for The Rite Sites plugin suite.
 *
 * WHY THIS EXISTS (2026-07-29)
 * ---------------------------------------------------------------------------
 * Five plugins each carried their own `zipping.config.js` - a full webpack
 * config whose only job was to copy a fixed list of directories into a staging
 * folder and zip it. Same file, five times, drifting.
 *
 * The obvious replacement, `wp-scripts plugin-zip`, does NOT work for this
 * suite. Measured against @wordpress/scripts 27.3.0 on 2026-07-29:
 *
 *   1. It writes a FLAT archive - no `<slug>/` folder inside the zip. Every
 *      shipped TRS zip nests its files under `<slug>/`, and that folder name
 *      becomes the plugin directory on install. Shipping a flat archive would
 *      make existing installs create a second copy instead of updating in
 *      place.
 *   2. It names the archive from package.json `name`, which for wc-net-profit
 *      is "woocommerce-net-profit" - not the plugin slug "wc-net-profit".
 *   3. It always injects package.json into the payload.
 *
 * `git archive --prefix=` would give the right shape but cannot be used
 * either: the payload includes `dist/`, which is build output and gitignored.
 *
 * So: this module. It stages the declared payload into `zip_files/<slug>/` and
 * shells out to `zip`. No npm dependency, no webpack, no machine paths.
 *
 * WHY NO MACHINE PATHS, AND WHY THAT MATTERS
 * ---------------------------------------------------------------------------
 * This runs identically on a laptop and on a CI runner. `trs-build-targets.js`
 * is the OTHER half of the build and is deliberately NOT used here - that one
 * resolves where to deliver a dev build on a particular machine, needs
 * `.trs-build.json`, and throws without it. A CI runner has no such file and
 * should not need one. Compiling and packaging are machine-independent;
 * delivering into a running site is not. Keep them apart.
 *
 * DECLARING THE PAYLOAD
 * ---------------------------------------------------------------------------
 * In the plugin's package.json:
 *
 *   "trsPackage": {
 *     "slug": "wc-net-profit",
 *     "include": [
 *       "assets", "cmb2", "dist", "includes", "woo-includes",
 *       "README.txt", "wc-net-profit.php"
 *     ]
 *   }
 *
 * `slug` is REQUIRED and is deliberately separate from package.json `name`.
 * The two disagree today in at least one plugin, and getting it wrong renames
 * the installed plugin directory - which silently breaks updates for every
 * existing customer rather than failing visibly. Say it out loud, once, here.
 *
 * `include` is the whole payload. Anything not listed does not ship. That is
 * the point: it replaces the hand-stripped `master` release branch, where the
 * payload was defined by deleting files from a branch and hoping nobody
 * forgot one.
 *
 * USAGE, from the plugin directory:
 *
 *   node ../trs-package.js            # or: npm run package
 *
 * Emits `zip_files/<slug>.zip`, staged from `zip_files/<slug>/`.
 */

'use strict';

const { execFileSync } = require( 'child_process' );
const fs = require( 'fs' );
const path = require( 'path' );

const STAGING_DIR = 'zip_files';

/**
 * Names that must never enter a release payload, at any depth.
 *
 * `.DS_Store` is the one that actually happens - the suite's working
 * directories are full of them and the shipped v2.1.1 zip has none, so it was
 * being filtered before. Doing it here means it stays filtered.
 */
const JUNK = new Set( [ '.DS_Store', '.AppleDouble', '.LSOverride', 'Thumbs.db' ] );

/**
 * Read and validate the `trsPackage` block from a plugin's package.json.
 *
 * @param {string} pluginDir Absolute path to the plugin working directory.
 * @return {{slug: string, include: string[]}} Validated payload declaration.
 * @throws {Error} When the block is missing or malformed.
 */
function readDeclaration( pluginDir ) {
	const pkgPath = path.join( pluginDir, 'package.json' );

	if ( ! fs.existsSync( pkgPath ) ) {
		throw new Error( `[trs-package] No package.json at ${ pkgPath }` );
	}

	let pkg;
	try {
		pkg = JSON.parse( fs.readFileSync( pkgPath, 'utf8' ) );
	} catch ( err ) {
		throw new Error( `[trs-package] ${ pkgPath } is not valid JSON: ${ err.message }` );
	}

	const decl = pkg.trsPackage;

	if ( ! decl ) {
		throw new Error(
			`[trs-package] ${ pkgPath } has no "trsPackage" block.\n\n` +
				`Add one. It declares the entire release payload:\n\n` +
				`  "trsPackage": {\n` +
				`    "slug": "the-plugin-directory-name",\n` +
				`    "include": [ "includes", "dist", "readme.txt", "the-plugin.php" ]\n` +
				`  }\n`
		);
	}

	if ( ! decl.slug || typeof decl.slug !== 'string' ) {
		throw new Error( `[trs-package] "trsPackage.slug" is required in ${ pkgPath }.` );
	}

	if ( ! Array.isArray( decl.include ) || decl.include.length === 0 ) {
		throw new Error( `[trs-package] "trsPackage.include" must be a non-empty array in ${ pkgPath }.` );
	}

	return { slug: decl.slug, include: decl.include };
}

/**
 * Copy one payload entry into the staging tree, dropping junk files.
 *
 * @param {string} from Absolute source path.
 * @param {string} to   Absolute destination path.
 */
function stageEntry( from, to ) {
	fs.cpSync( from, to, {
		recursive: true,
		filter: ( src ) => ! JUNK.has( path.basename( src ) ),
	} );
}

/**
 * Build the release zip for one plugin.
 *
 * @param {string} [pluginDir] Plugin working directory. Defaults to cwd.
 * @return {{zipPath: string, slug: string, fileCount: number}} Result summary.
 * @throws {Error} On a missing declaration or a missing payload entry.
 */
function build( pluginDir = process.cwd() ) {
	const root = path.resolve( pluginDir );
	const { slug, include } = readDeclaration( root );

	// Fail on the WHOLE missing set, not the first one. A forgotten `npm run
	// build` leaves several entries missing at once, and reporting them one
	// run at a time turns a ten-second fix into four.
	const missing = include.filter( ( entry ) => ! fs.existsSync( path.join( root, entry ) ) );

	if ( missing.length ) {
		throw new Error(
			`[trs-package] ${ slug }: declared payload entries do not exist:\n` +
				missing.map( ( m ) => `  - ${ m }` ).join( '\n' ) +
				`\n\nIf "dist" is among them, run the compile step first (npm run build).`
		);
	}

	const stagingRoot = path.join( root, STAGING_DIR );
	const stageDir = path.join( stagingRoot, slug );
	const zipName = `${ slug }.zip`;
	const zipPath = path.join( stagingRoot, zipName );

	fs.rmSync( stageDir, { recursive: true, force: true } );
	fs.rmSync( zipPath, { force: true } );
	fs.mkdirSync( stageDir, { recursive: true } );

	for ( const entry of include ) {
		stageEntry( path.join( root, entry ), path.join( stageDir, entry ) );
	}

	// -r recurse, -q quiet, -X drop extra platform attributes so the archive
	// does not carry macOS resource forks to a customer's server.
	execFileSync( 'zip', [ '-r', '-q', '-X', zipName, slug ], {
		cwd: stagingRoot,
		stdio: [ 'ignore', 'inherit', 'inherit' ],
	} );

	let fileCount = 0;
	const walk = ( dir ) => {
		for ( const item of fs.readdirSync( dir, { withFileTypes: true } ) ) {
			if ( item.isDirectory() ) {
				walk( path.join( dir, item.name ) );
			} else {
				fileCount += 1;
			}
		}
	};
	walk( stageDir );

	return { zipPath, slug, fileCount };
}

module.exports = { build, readDeclaration };

if ( require.main === module ) {
	try {
		const { zipPath, slug, fileCount } = build();
		process.stdout.write( `[trs-package] ${ slug }: ${ fileCount } files -> ${ zipPath }\n` );
	} catch ( err ) {
		process.stderr.write( `${ err.message }\n` );
		process.exit( 1 );
	}
}
