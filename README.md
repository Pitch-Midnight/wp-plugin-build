# wp-plugin-build - shared build tooling for the TRS plugin suite

This repo is small on purpose. It contains **one module and one example config**.
Everything else in this directory belongs to someone else.

## What this directory is

`~/dev-env/plugins/trs` is the working root for The Rite Sites WordPress plugin
suite. It holds roughly 35 plugin directories. Sixteen of them are independent
git repositories with their own remotes (`theritesite/wc-net-profit`,
`theritesite/cog-wc`, and so on); the rest are unversioned working copies,
backups, and old learning projects.

**None of those directories are part of this repo.** The `.gitignore` denies
everything by default and allows back only the four shared files. See the
comments in that file for why it is written that way.

| Tracked here | What it is |
|---|---|
| `trs-build-targets.js` | The build-destination resolver every plugin imports |
| `.trs-build.example.json` | Template for the per-machine config |
| `.gitignore` | The deny-by-default rule that keeps the plugins out |
| `README.md` | This file |

## Why the resolver exists

Every plugin's `webpack.config.js` used to carry its own private copy of the
machine paths, selected by an `env.LOC` string:

```js
if ( env.LOC === "corsair" ) { devFolder = '/var/www/wpdev.com/...'; }
if ( env.LOC === "mac" )     { devFolder = '/Users/parker/sites/...'; }
if ( env.LOC === "m1" )      { devFolder = '/Users/parkermathewson/...'; }
```

That scheme **has already failed twice.** `corsair` was a Linux box that is
gone; `mac` was an older Mac under a different username. Both paths point at
nothing today. Because the paths were duplicated into roughly twenty configs,
each machine change meant twenty hand edits - which is why two of the three
targets were left broken rather than fixed.

The paths now live in one JSON file. A plugin asks this module where to put
things and knows nothing about the machine it is running on.

It also fixes a real bug. The old code assigned `devFolder`, `endPath` and
`buildPath` as **implicit globals** with no `const`/`let`, so an unrecognised
`LOC` left them `undefined` and webpack cheerfully copied files to nonsense
destinations without failing. The resolver throws a named error instead. A build
that cannot find its target should stop, not misfile.

## Setting up on a new machine

The config is searched in this order, first hit wins:

1. `$TRS_BUILD_CONFIG` - an explicit path, for CI or one-off overrides
2. `~/.trs-build.json` - per-machine, and survives moving `dev-env`
3. `<this directory>/.trs-build.json`

Copy the example to one of those and edit the paths:

```bash
cp .trs-build.example.json ~/.trs-build.json
```

```json
{
  "defaultTarget": "m1",
  "targets": {
    "m1": {
      "site": "/Users/you/mac-sites/wp56tester/wp-content/plugins",
      "artifacts": "/Users/you/theritesites/completed_pluginsv2"
    }
  }
}
```

`site` is the **plugins directory** of the WordPress install the watch build
writes into. `artifacts` is where production builds and zips land. The plugin
slug is appended to both, so do not include it.

The real `.trs-build.json` is gitignored. If it is missing, the resolver throws
and prints every path it looked in.

## Wiring a plugin to it

In the plugin's `webpack.config.js`:

```js
const trsTargets = require( '../trs-build-targets' );

const config = ( env, argv ) => {
    const { devFolder, endFolder, target, source } =
        trsTargets.resolve( pluginSlug, env.LOC );
    // devFolder  -> <site>/<pluginSlug>        (watch/dev copy destination)
    // endFolder  -> <artifacts>/<pluginSlug>   (production copy destination)
```

`resolve()` also returns `endPath` and `buildPath`, both the bare `artifacts`
path, for configs that used those names.

The `require` is a relative path, so **a plugin only resolves this while it sits
inside `~/dev-env/plugins/trs/`.** Cloned somewhere else it will fail with a
module-not-found error rather than a confusing path bug.

## Migration status

| Plugin | State |
|---|---|
| `wc-net-profit` | **Done** (2026-07-27, branch `dev-2.1-patch`). Verified: old and new configs resolve identical `CopyWebpackPlugin` destinations - 7 in development, 14 in production - and a real `npm run start-m1-nw` build rewrote 19 files into the target site |
| `cog-wc`, `cr-wc-dev`, `woocommerce-cost-of-shipping`, `wc-specgen-pdf` | Same `LOC` pattern, not yet migrated |
| `add-to-cart-pro`, `aoc-wc`, `enhanced-ajax-add-to-cart-wc` | Pass `--env LOC=m1` in `package.json` but have **no `LOC` branch in their webpack config at all**. Need investigating before migrating - the destination is set somewhere else, or not at all |

Retired target definitions are kept under `_retired` in the local config as a
record of what `corsair` and `mac` used to mean. Moving one back into `targets`
is all it takes to revive it.
