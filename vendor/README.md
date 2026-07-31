# vendor - canonical copies of shared libraries

Libraries that get injected into a plugin's release zip at package time, rather
than being committed into each plugin.

## Why this exists

The suite already vendors CMB2 into six plugins, at **2.2.5.3, 2.6.0, 2.10.1
and three copies nobody has read** (audit 2026-07-30). CMB2 loads exactly one
copy per request, chosen by a `CMB2_Bootstrap_XXXX` priority race, so a plugin
shipping 2.2.5.3 on a site running another at 2.10.1 executes against a version
it was never tested with. Nobody chose that; it accumulated.

Injecting from one place at package time makes a single version true **by
construction** rather than by remembering to update six directories.

## How a plugin opts in

Nothing happens unless a plugin asks. In its `package.json`:

```json
"trsPackage": {
  "slug": "cog-wc",
  "include": [ "includes", "dist", "README.txt", "cog-wc.php" ],
  "vendor": [ "cmb2" ]
}
```

That copies `vendor/cmb2/` to `cog-wc/cmb2/` inside the zip. For a different
destination, use the object form:

```json
"vendor": { "cmb2": "lib/cmb2" }
```

Injection happens **after** the declared payload, so a plugin still carrying its
own stale copy has it overwritten by the canonical one rather than silently
winning.

`trs-package.js` fails loudly if a declared library is not here, and prints what
it injected - a library appearing in a customer's zip without being visible in
the plugin's own tree should never surprise whoever built it.

## What is not here yet, and the decision it needs

**CMB2 itself.** Two things have to be settled first, and neither is mechanical:

1. **Which version.** The newest copy in the suite is 2.10.1 and current is
   2.11.x. Standardising means some plugins jump several major-minor versions -
   `pretty-coupons-for-woocommerce` would go from 2.2.5.3, which is a six-year
   jump and needs testing rather than assuming.
2. **Whether a public repository should carry it.** This repo is public. CMB2 is
   GPL-2 so redistribution is fine, but it is roughly 3.8MB, and that is a
   choice rather than an oversight.

Until both are answered, `trsPackage.vendor` works and simply has nothing to
offer.

## What else belongs here later

The shared Pitch Midnight settings framework, when a second plugin needs it.
The same reasoning applies with more force: a framework copied into five
plugins is the CMB2 failure wearing our own logo, except we would own both
sides of it. See `parker-context/pitch-midnight/11-cmb2-dependency-decision.md`.
