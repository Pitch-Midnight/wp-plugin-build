<?php
/**
 * The #[PM\Premium] build marker.
 *
 * See parker-context/pitch-midnight/20-tier-build-split.md for the full
 * design. This file has ZERO runtime behavior - PHP does not resolve or
 * even autoload an attribute's class unless something explicitly calls
 * ReflectionClass::getAttributes(), which nothing in this suite does. A
 * plugin can carry #[PM\Premium] on a declaration without this file
 * present at all and it will run correctly; this class exists only so an
 * IDE or static analyzer that DOES resolve attributes has something real
 * to resolve, and so `use PM\Premium;` is available for the short form.
 *
 * The build-time meaning lives entirely in trs-strip.js, which looks for
 * the literal token sequence `#[PM\Premium]` (or `#[\PM\Premium]`) via
 * PHP's own tokenizer - it never loads or reflects this class either.
 *
 * VENDORED, NOT PER-PLUGIN. Copied into a plugin's payload at package
 * time only if the plugin's trsPackage.vendor lists "pm-premium" AND its
 * source actually references #[PM\Premium] somewhere that survives into
 * the premium build (which it always does - stripping only ever touches
 * the free-tier copy). Most plugins that use the attribute will want it
 * vendored so the class exists in both shipped tiers' source trees, even
 * though nothing ever calls it.
 *
 * DO NOT add a constructor, properties, or any other member. A marker
 * attribute that starts doing something is a marker that stopped being
 * inert, and inertness is what keeps trs-strip.js's grammar decidable -
 * see 20-tier-build-split.md's "Markers are build-time only" section.
 */

namespace PM;

#[\Attribute]
final class Premium {
}
