/**
 * Shared build-target resolver for The Rite Sites plugin suite.
 *
 * WHY THIS EXISTS (2026-07-27)
 * ---------------------------------------------------------------------------
 * Every plugin's webpack.config.js used to carry its own copy of the machine
 * paths, selected by an `env.LOC` string:
 *
 *     if ( env.LOC === "corsair" ) { devFolder = '/var/www/...'; }
 *     if ( env.LOC === "mac" )     { devFolder = '/Users/parker/...'; }
 *     if ( env.LOC === "m1" )      { devFolder = '/Users/parkermathewson/...'; }
 *
 * That scheme has already failed twice - "corsair" (a retired Linux box) and
 * "mac" (an older Mac, user `parker`) both point at paths that no longer exist.
 * Each failure required editing roughly twenty webpack configs by hand, because
 * the paths were duplicated into every plugin.
 *
 * The paths now live in ONE json file. Plugins ask this module where to put
 * things and stop knowing anything about the machine they are running on.
 *
 * WHERE THE CONFIG LIVES
 * ---------------------------------------------------------------------------
 * Searched in this order, first hit wins:
 *
 *   1. $TRS_BUILD_CONFIG           (explicit path, for CI or one-off overrides)
 *   2. ~/.trs-build.json           (per-machine, survives moving dev-env)
 *   3. <this directory>/.trs-build.json
 *
 * Shape:
 *
 *   {
 *     "defaultTarget": "m1",
 *     "targets": {
 *       "m1": {
 *         "site":      "/abs/path/to/wp-site/wp-content/plugins",
 *         "artifacts": "/abs/path/to/completed_plugins"
 *       }
 *     }
 *   }
 *
 * USAGE in a plugin's webpack.config.js:
 *
 *   const trsTargets = require( '../trs-build-targets' );
 *   const { devFolder, endPath, buildPath, endFolder } =
 *       trsTargets.resolve( pluginSlug, env.LOC );
 *
 * BEHAVIOUR CHANGE, ON PURPOSE: the old code used implicit globals with no
 * `const`/`let`, so an unrecognised LOC left every path `undefined` and webpack
 * happily copied files to nonsense destinations. This module throws instead.
 * A build that cannot find its target should stop, not silently misfile.
 */

'use strict';

const fs = require( 'fs' );
const os = require( 'os' );
const path = require( 'path' );

const CONFIG_BASENAME = '.trs-build.json';

/**
 * Ordered list of candidate config paths.
 *
 * @return {string[]} Absolute paths, most specific first.
 */
function candidatePaths() {
	const candidates = [];

	if ( process.env.TRS_BUILD_CONFIG ) {
		candidates.push( path.resolve( process.env.TRS_BUILD_CONFIG ) );
	}

	candidates.push( path.join( os.homedir(), CONFIG_BASENAME ) );
	candidates.push( path.join( __dirname, CONFIG_BASENAME ) );

	return candidates;
}

/**
 * Read and parse the first config file found.
 *
 * @return {{config: Object, source: string}} Parsed config and where it came from.
 * @throws {Error} When no config exists, or the one found is not valid JSON.
 */
function loadConfig() {
	const candidates = candidatePaths();

	for ( const candidate of candidates ) {
		if ( ! fs.existsSync( candidate ) ) {
			continue;
		}

		let raw;
		try {
			raw = fs.readFileSync( candidate, 'utf8' );
		} catch ( err ) {
			throw new Error(
				`[trs-build-targets] Found ${ candidate } but could not read it: ${ err.message }`
			);
		}

		try {
			return { config: JSON.parse( raw ), source: candidate };
		} catch ( err ) {
			throw new Error(
				`[trs-build-targets] ${ candidate } is not valid JSON: ${ err.message }`
			);
		}
	}

	throw new Error(
		'[trs-build-targets] No build config found. Looked in:\n' +
			candidates.map( ( c ) => `  - ${ c }` ).join( '\n' ) +
			`\n\nCreate one. Minimum shape:\n` +
			`  {\n` +
			`    "defaultTarget": "m1",\n` +
			`    "targets": {\n` +
			`      "m1": {\n` +
			`        "site": "/abs/path/to/site/wp-content/plugins",\n` +
			`        "artifacts": "/abs/path/to/completed_plugins"\n` +
			`      }\n` +
			`    }\n` +
			`  }`
	);
}

/**
 * Resolve the build destinations for one plugin on one machine.
 *
 * @param {string} pluginSlug Plugin directory name, e.g. 'wc-net-profit'.
 * @param {string} [loc]      Target name. Falls back to config.defaultTarget.
 * @return {{devFolder: string, endPath: string, buildPath: string, endFolder: string, target: string, source: string}}
 * @throws {Error} On unknown target or incomplete target definition.
 */
function resolve( pluginSlug, loc ) {
	if ( ! pluginSlug ) {
		throw new Error( '[trs-build-targets] resolve() requires a pluginSlug.' );
	}

	const { config, source } = loadConfig();
	const targets = config.targets || {};
	const name = loc || config.defaultTarget;

	if ( ! name ) {
		throw new Error(
			`[trs-build-targets] No target given and no "defaultTarget" set in ${ source }.\n` +
				`Pass one with --env LOC=<name>. Known targets: ${ Object.keys( targets ).join( ', ' ) || '(none)' }`
		);
	}

	const target = targets[ name ];

	if ( ! target ) {
		throw new Error(
			`[trs-build-targets] Unknown target "${ name }".\n` +
				`Config: ${ source }\n` +
				`Known targets: ${ Object.keys( targets ).join( ', ' ) || '(none)' }`
		);
	}

	for ( const key of [ 'site', 'artifacts' ] ) {
		if ( ! target[ key ] ) {
			throw new Error(
				`[trs-build-targets] Target "${ name }" in ${ source } is missing "${ key }".`
			);
		}
	}

	const endPath = path.resolve( target.artifacts );

	return {
		devFolder: path.resolve( target.site, pluginSlug ),
		endPath,
		buildPath: endPath,
		endFolder: endPath + '/' + pluginSlug,
		target: name,
		source,
	};
}

module.exports = { resolve, loadConfig, candidatePaths };
