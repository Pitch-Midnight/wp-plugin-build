# tier-split-demo - a live smoke test, not a plugin

Not published anywhere, not cloned into any site, never referenced by CI.
Exercises every marker shape `trs-strip.js` needs to handle in one small
tree, so the tier build split (`parker-context/pitch-midnight/20-tier-build-split.md`)
has something real to run against without needing a full plugin.

## Run it

    cd test-fixtures/tier-split-demo
    node ../../trs-package.js

Produces `zip_files/tier-split-demo.zip` (premium, unmodified source) and
`zip_files/tier-split-demo-free.zip` (derived - `premium/` excluded,
`#[PM\Premium]` declarations and `<pm:premium>` fence content stripped,
header rewritten). Inspect either with `unzip -l` / `unzip -p`.

## What each file is for

- `tier-split-demo.php` - main file. Carries `Update URI`, which the free
  build's header transform deletes - confirms the same-slug/Update-URI
  mechanism the design doc's header section describes.
- `includes/class-reports.php` - the interesting one. `free_report()` and
  `dispatch()`'s free branch must survive unchanged; `segmentation_report()`
  (a `#[PM\Premium]` method) and the `<pm:premium>` fence inside
  `dispatch()` must both be gone from the free build, and the file must
  still `php -l` clean afterward.
- `premium/class-advanced.php` - level-1 whole-directory exclusion. Absent
  from the free zip entirely, not stripped-and-empty.
- `package.json` - the `trsPackage.tiers` declaration itself; the
  reference example for a plugin adopting this.

## Regression check this fixture does NOT replace

This fixture only proves the TIERED path. Before trusting any change to
`trs-package.js`, also confirm the UNTIERED path is byte-identical - copy
a real plugin (aoc-wc is a good pick, no tiers declared), build it with the
changed script and with `git show main:trs-package.js`, and diff the two
zips' contents by md5. A tiered-path fix that quietly changes untiered
output is a regression across the whole suite, not just this fixture.
