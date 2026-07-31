# template - the house shape for a TRS plugin

`template/plugin/` is a complete, working, empty WordPress plugin. Copy it,
substitute the placeholders, and you have a plugin that already agrees with the
shared build tooling in this repo: `trs-package.js` can zip it and
`trs-verify-versions.js` passes on it before you have written a line of your own
code.

It replaces `theritesite/trs-plugin-gen`, which was archived on 2026-07-30.

## Where this came from

`trs-plugin-gen` was a copy of `tmeister/wppb-gen`, the web front end to Tom
McFarlin's WordPress Plugin Boilerplate. It generated every plugin in this suite
and it had not run since 2020 - `engines` pinned `node 0.10.x`, so it was
unrunnable rather than merely out of date. Its tag `upstream-wppb-gen` marks
where the upstream copy ended.

**The generator was the disposable part; the convention it produced was not.**
Seven shipping plugins share a layout because that tool enforced one, and shared
layout is what makes a plugin you have not opened in two years readable in an
afternoon. That convention is what this directory preserves.

## What was deliberately kept

- The `@wordpress-plugin` header docblock, and `@since` / `@package` /
  `@subpackage` / `@author` / `@link` on every class
- `includes/` with `class-<slug>-<thing>.php` file naming
- `index.php` silence guards in every directory
- `uninstall.php`, separate from deactivation
- `languages/` and text-domain wiring
- `LICENSE.txt` (GPL-2) and `README.txt` with a `Stable tag` and a changelog
- The activator / deactivator / i18n split

## What was deliberately dropped

- **The `admin/` and `public/` split.** It is a 2013 pattern that predates the
  block editor. `add-to-cart-pro` already has `blocks/` and `build/` bolted onto
  the side of it, which is what a structure looks like after it stops fitting.
- **The loader class.** It collected hooks far from the code that services them,
  which was a consequence of the admin/public split. Each service now registers
  its own hooks in `register_hooks()`. See the note in
  `includes/class-plugin-name.php`.

Nothing was added that brings a new dependency. There is no Composer autoloader
and no build step: `require_once` in the bootstrap file, which is what the rest
of the suite already does. A plugin that needs webpack adds it; see the wiring
section in the repo README.

## Using it

```bash
cd ~/dev-env/plugins/trs
cp -R template/plugin my-new-plugin
cd my-new-plugin
```

Then substitute the placeholders below, rename the four files that carry
`plugin-name` in their names, and check it:

```bash
npm run verify-versions
npm run package        # emits zip_files/<slug>.zip
```

`CLAUDE.md` in this directory states the substitution points precisely, so
"scaffold me a plugin called X" works as a prompt rather than needing a program.
That is the replacement for the generator.

### The placeholders

| Token | Becomes | Example |
|---|---|---|
| `plugin-name` | the slug, kebab-case | `wc-order-tags` |
| `plugin_name` | function and hook prefix, snake_case | `wc_order_tags` |
| `Plugin_Name` | class prefix, Studly_Snake | `WC_Order_Tags` |
| `PLUGIN_NAME` | constant prefix, upper snake | `WC_ORDER_TAGS` |
| `Plugin Name` | display name | `WC Order Tags` |
| `PLUGIN_DESCRIPTION` | one-line description | ... |

The slug appears in three places that must agree: the directory name, the main
file name, and `trsPackage.slug` in `package.json`. That value becomes the
folder inside the release zip and therefore the installed directory name, so a
mismatch does not fail the build - it silently breaks updates for every existing
install.

### Versions must agree in four places

`trs-verify-versions.js` fails the release when the plugin header `Version:`,
the `PLUGIN_NAME_VERSION` constant, `version` in `package.json`, and
`README.txt`'s `Stable tag` plus newest changelog entry are not identical. The
template ships all four at `1.0.0`.

## Keeping it honest

This template is only worth having if it stays the shape the suite is actually
migrating toward. When a decision in a real plugin contradicts it, change the
template in the same pass - a template nobody updated is worse than none,
because it looks authoritative.
