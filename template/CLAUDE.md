# CLAUDE.md - scaffolding a plugin from this template

This file exists so that "scaffold me a plugin called X" is a prompt rather than
a program. Read `README.md` in this directory first for what the template is and
why it has the shape it has.

## The procedure

Given a plugin name, do all of the following. Do not skip the rename step; a
copied template whose files still say `plugin-name` is the single most common
way this goes wrong.

1. **Copy** `template/plugin/` to `~/dev-env/plugins/trs/<slug>/`.
2. **Rename** the files whose names carry the token:
   - `plugin-name.php` -> `<slug>.php`
   - `includes/class-plugin-name.php` -> `includes/class-<slug>.php`
   - `includes/class-plugin-name-activator.php` -> `includes/class-<slug>-activator.php`
   - `includes/class-plugin-name-deactivator.php` -> `includes/class-<slug>-deactivator.php`
   - `includes/class-plugin-name-i18n.php` -> `includes/class-<slug>-i18n.php`
3. **Substitute** every token in the table below, in every file including
   `README.txt`, `package.json` and `.github/workflows/release.yml`.
4. **Set the owner, deliberately.** The template defaults to The Rite Sites in
   `Author:`, `Author URI:`, every `@author` and `@link`, `Contributors:` in
   `README.txt`, and `author` in `package.json`. **These are literals, not
   tokens, because getting them wrong is not a typo.** A plugin owned by Pitch
   Midnight LLC and shipped carrying a The Rite Sites byline misstates who owns
   it, which is the precise failure `05-ip-and-code-ownership.md` in
   `parker-context` exists to prevent. Ask whose plugin it is before copying,
   and if the answer is not obvious, stop and ask Parker - the repo it lands in
   and the prefix it carries both encode the answer.
5. **Nothing to delete.** This file and `README.md` sit at `template/`, one
   level above `template/plugin/`, precisely so that a copy of the plugin
   directory never carries the template's own documentation into a real repo.
   Copy `template/plugin`, never `template`.
6. **Verify** before reporting done:
   ```bash
   cd ~/dev-env/plugins/trs/<slug>
   grep -ri "plugin.name\|PLUGIN_DESCRIPTION" .    # must return nothing
   php -l <slug>.php && for f in includes/*.php; do php -l "$f"; done
   npm run verify-versions
   ```

## Substitution table

Order matters: replace the longer and case-specific tokens before the shorter
ones, or `plugin-name` will eat the file names inside `Plugin_Name`.

| Token | Replace with | Case |
|---|---|---|
| `PLUGIN_DISPLAY_NAME` | display name | Title Case |
| `PLUGIN_DESCRIPTION` | the one-line description | as written |
| `PLUGIN_NAME` | constant prefix | UPPER_SNAKE |
| `Plugin_Name` | class prefix | Studly_Snake |
| `plugin_name` | function and hook prefix | snake_case |
| `plugin-name` | the slug | kebab-case |

**Never make the display name a bare `Plugin Name` token.** `Plugin Name:` is a
WordPress header field name, so substituting the bare string rewrites the field
name along with its value and yields a file WordPress does not see as a plugin.
That is why `PLUGIN_DISPLAY_NAME` exists. It happened once, on 2026-07-30.

All five casings derive from one input. For a plugin called "WC Order Tags":
slug `wc-order-tags`, functions `wc_order_tags`, classes `WC_Order_Tags`,
constants `WC_ORDER_TAGS`, display `WC Order Tags`.

## Invariants to preserve

These are not style preferences; breaking one causes a specific failure.

- **The slug appears in the directory name, the main file name, and
  `trsPackage.slug`, and all three must be identical.** `trs-package.js` uses
  `trsPackage.slug` as the folder inside the zip, which becomes the installed
  directory name. A mismatch does not fail the build - it makes WordPress create
  a second plugin directory on update instead of replacing the first, which
  breaks every existing install silently.
- **The version appears in four places and they must be identical:** the plugin
  header `Version:`, `define( '<PREFIX>_VERSION', ... )`, `version` in
  `package.json`, and `README.txt`'s `Stable tag` plus its newest changelog
  entry. `trs-verify-versions.js` is a hard gate on this.
- **The version constant name should end in `_VERSION`.** The verifier
  auto-discovers constants by that suffix. If a plugin genuinely needs another
  name, declare it in `trsPackage.versionConstants` or the verifier reports the
  plugin as having no constant while a drifted one sits in plain sight.
- **No `add_action` or `add_filter` at file scope.** Services register their own
  hooks in `register_hooks()`, called from `Plugin_Name::run()`.
- **Nothing runs at include time.** The bootstrap hooks `plugins_loaded`.

## What not to add without asking

- **Any new dependency**, including Composer, an autoloader, a framework, or a
  test runner. A new dependency in this workspace requires a written decision
  doc first: why it is required, what alternatives were considered, why this one
  won, what guardrails contain it. Scaffolding a plugin is not the moment to
  make that call.
- **A build step.** The template has none on purpose. Add webpack only when the
  plugin actually has assets to compile, and wire it to `trs-build-targets.js`
  rather than putting machine paths in the config - see the repo README for why
  that rule exists.
- **`admin/` and `public/` directories.** Dropped deliberately. If the plugin
  needs an admin screen, that is a service class in `includes/`.
