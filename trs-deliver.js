/**
 * Deliver a staged release payload into a local WordPress install.
 *
 * WHY THIS EXISTS (2026-07-29)
 * ---------------------------------------------------------------------------
 * Delivery used to be done by CopyWebpackPlugin inside the build. That has a
 * race that produced a real defect: CopyWebpackPlugin globs its source
 * directories when the compilation STARTS, but webpack's own output is written
 * when the compilation ENDS. So a freshly built asset is not there yet to be
 * copied.
 *
 * Concretely, in cog-wc: `npm run clean` deletes assets/js/<slug>.min.js, the
 * production build re-creates it, and the copy step - which globbed assets/**
 * before that happened - delivered everything EXCEPT the file the build just
 * made. The zip was correct and the running site was not.
 *
 * `trs-package.js` has already staged the exact shipped payload into
 * zip_files/<slug>/ by the time this runs. Copying that is race-free by
 * construction, and it guarantees the running site contains precisely what a
 * customer would get - which is the whole point of having a near-production
 * local install.
 *
 * SEPARATION OF CONCERNS, which is the same split as everywhere else here:
 *
 *   trs-build-targets.js   where this machine puts things   machine-specific
 *   trs-package.js         what ships                       machine-independent
 *   trs-verify-versions.js whether it is coherent           machine-independent
 *   trs-deliver.js         put it on this machine           machine-specific
 *
 * This is the only one of the four that a CI runner must never need, and it is
 * never invoked by `npm run package`.
 *
 * USAGE, from the plugin directory:
 *
 *   node ../trs-deliver.js m1        # or: npm run deploy
 *
 * The target name is the same one `--env LOC` takes and is resolved by
 * trs-build-targets.js against .trs-build.json.
 */

'use strict';

const fs = require( 'fs' );
const path = require( 'path' );

const STAGING_DIR = 'zip_files';

/**
 * Copy the staged payload into the resolved local site.
 *
 * @param {string} [target]     Target name, e.g. 'm1'. Falls back to defaultTarget.
 * @param {string} [pluginDir]  Plugin working directory. Defaults to cwd.
 * @return {{slug: string, from: string, to: string, fileCount: number}} Result.
 * @throws {Error} When nothing has been staged, or the target does not resolve.
 */
function deliver( target, pluginDir = process.cwd() ) {
	const root = path.resolve( pluginDir );
	const pkg = JSON.parse( fs.readFileSync( path.join( root, 'package.json' ), 'utf8' ) );
	const decl = pkg.trsPackage;

	if ( ! decl || ! decl.slug ) {
		throw new Error( '[trs-deliver] package.json needs a trsPackage block with a slug.' );
	}

	const { slug } = decl;
	const staged = path.join( root, STAGING_DIR, slug );

	if ( ! fs.existsSync( staged ) ) {
		throw new Error(
			`[trs-deliver] nothing staged at ${ STAGING_DIR }/${ slug }.\n` +
				'Run `npm run package` first - this delivers what that produced, ' +
				'so that the running site and the shipped zip cannot differ.'
		);
	}

	// Resolved here rather than at module scope so that requiring this file
	// never depends on a machine config existing.
	const targets = require( './trs-build-targets' ).resolve( slug, target );
	const destination = targets.devFolder;

	fs.mkdirSync( path.dirname( destination ), { recursive: true } );

	// Replace rather than merge. A merge leaves files behind that the payload
	// no longer contains, which is how a local install ends up with stale code
	// that no customer has - and that is a debugging trap, not a convenience.
	fs.rmSync( destination, { recursive: true, force: true } );
	fs.cpSync( staged, destination, { recursive: true } );

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
	walk( destination );

	return { slug, from: staged, to: destination, fileCount, target: targets.target };
}

module.exports = { deliver };

if ( require.main === module ) {
	try {
		const { slug, to, fileCount, target } = deliver( process.argv[ 2 ] || undefined );
		process.stdout.write(
			`[trs-deliver] ${ slug }: ${ fileCount } files -> ${ to } (target ${ target })\n`
		);
	} catch ( err ) {
		process.stderr.write( `${ err.message }\n` );
		process.exit( 1 );
	}
}
