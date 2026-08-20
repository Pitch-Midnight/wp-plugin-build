#!/usr/bin/env bash
#
# WordPress-version test gate, built for the SVN release pipeline.
#
# Runs a plugin's PHPUnit suite against a matrix of WordPress core versions,
# reusing wp-test-env.sh (parker-context/scripts/) for the actual
# setup/test steps rather than reimplementing them. Built 2026-08-20 to
# close todos/pitch-midnight/wp-version-matrix-release-gate.md: svn-push.sh
# shipped aoc-wc 1.0.6 with a "Tested up to: 6.5" that had never been
# checked against anything past that, because nothing in the release path
# ran the test suite at all, against any WordPress version - a post-hoc
# check the same day found `4 tests, 10 assertions, OK` against WP 7.0.4,
# so the fix was real; the gap was that this only got checked after
# shipping, not before.
#
# USAGE
#   wp-version-matrix.sh <plugin-dir>
#
#   <plugin-dir> is a checkout with bin/setup-tests.sh, composer.json, and
#   phpunit.xml at its root - what svn-push.sh already has cloned into
#   $BUILD/src by the time it calls this.
#
# WHAT IT DOES
#   For each version in $WP_VERSION_MATRIX (space-separated; default
#   "latest" - see the scoping note in wp-version-matrix-release-gate.md
#   for why the default is not also naming trailing majors), calls
#   wp-test-env.sh's own "setup" then "test" commands, with WP_CORE_DIR and
#   WP_TESTS_DIR pointed at a version-specific directory under a fresh
#   mktemp root.
#
#   That per-version isolation is not optional: bin/install-wp-tests.sh
#   returns early from install_wp() if WP_CORE_DIR already exists -
#   including across two DIFFERENT requested versions in the same run - so
#   without it, only the first version in the matrix would ever really
#   download and test; every version after that would silently reuse
#   whatever core the first call installed and report a pass that proves
#   nothing about the version it claims to be testing.
#
#   After every version passes, reads the resolved numeric version straight
#   out of that install's wp-includes/version.php - never the literal
#   string "latest" - and prints the highest one on its own
#   MATRIX_HIGHEST_VERSION=<version> line, which svn-push.sh greps out to
#   update "Tested up to:" on the built payload.
#
# REFUSES, DOES NOT SILENTLY SKIP, WHEN
#   - <plugin-dir>/bin/setup-tests.sh does not exist. This gate reuses that
#     script rather than reimplementing WooCommerce-borrowing itself, so a
#     plugin without one has no gate to run - and shipping through
#     unchecked either way is exactly the gap this file exists to close.
#     As of 2026-08-20 that is true for woocommerce-cost-of-shipping; see
#     wp-version-matrix-release-gate.md's "Left" section rather than
#     silently exempting it here.
#   - any version in the matrix fails setup or the suite.
#
#   svn-push.sh's own WP_VERSION_GATE_SKIP=1 escape hatch lives in that
#   script, not here, and logs loudly either way it goes - see there.
#
# WHY THE INTERACTIVE PROMPT IS AUTO-ANSWERED
#   bin/install-wp-tests.sh asks "continue? [y/n]" before it will touch
#   DB_NAME, and this gate answers "y" for every version without asking a
#   human. That is safe only because wp-test-env.sh already refuses any
#   DB_NAME outside `wordpress_test*` before this script is ever reached -
#   the same guardrail an interactive run already relies on, not a new one
#   introduced here to make automation possible.

set -euo pipefail

die() {
	echo "wp-version-matrix: REFUSING - $1" >&2
	exit 1
}

PLUGIN_DIR="${1:?usage: wp-version-matrix.sh <plugin-dir>}"
cd "$PLUGIN_DIR"

[ -x bin/setup-tests.sh ] || die "no bin/setup-tests.sh in $PLUGIN_DIR - this plugin has no test infra wired for the version gate yet (mirror aoc-wc's bin/setup-tests.sh, or release via svn-push.sh's WP_VERSION_GATE_SKIP=1)."
[ -f composer.json ] || die "no composer.json in $PLUGIN_DIR"

WP_TEST_ENV_BIN="${WP_TEST_ENV_BIN:-$HOME/claude/pm-dev/parker-context/scripts/wp-test-env.sh}"
[ -x "$WP_TEST_ENV_BIN" ] || die "$WP_TEST_ENV_BIN not found or not executable"

if [ ! -x vendor/bin/phpunit ]; then
	echo "--- vendor/bin/phpunit missing - running composer install first ---"
	composer install --no-interaction --no-progress
fi

MATRIX_VERSIONS="${WP_VERSION_MATRIX:-latest}"
MATRIX_ROOT=$(mktemp -d)
trap 'rm -rf "$MATRIX_ROOT"' EXIT

# Zero-pads each dot-separated component to 5 digits so plain string
# comparison sorts numerically - "7.0.4" must outrank "6.8.12" even though
# "7" < "68" as text.
version_sort_key() {
	echo "$1" | awk -F. '{ printf "%05d%05d%05d\n", $1+0, $2+0, $3+0 }'
}

declare -a RESULTS=()
HIGHEST=""
HIGHEST_KEY=0
FAILED=0

for version in $MATRIX_VERSIONS; do
	echo ""
	echo "--- WP version gate: ${version} ---"
	# Trailing slash on WP_CORE_DIR is not cosmetic: install-wp-tests.sh's
	# install_test_suite() sed-replaces the sample config's
	# "dirname( __FILE__ ) . '/src/'" wholesale with "'$WP_CORE_DIR'", and
	# that value becomes ABSPATH verbatim. Every WP core file assumes
	# ABSPATH already ends in '/' (ABSPATH . 'wp-settings.php'); without
	# the trailing slash here that concatenates to a nonexistent
	# "corewp-settings.php" and every version in the matrix fails the same
	# way. Found live 2026-08-20 running this gate for the first time
	# against a directory that had never held a WP core before - the
	# normal single-version flow never surfaces this because
	# /tmp/wordpress-tests-lib's wp-tests-config.php, once generated
	# correctly by an earlier direct call, is never regenerated
	# (install_test_suite only writes it "if [ ! -f wp-tests-config.php ]").
	# bin/setup-tests.sh's own WP_CORE_DIR default (/tmp/wordpress, no
	# trailing slash) has the exact same latent bug - it is just dormant
	# there because that config file already exists on this machine.
	export WP_CORE_DIR="$MATRIX_ROOT/${version}/core/"
	export WP_TESTS_DIR="$MATRIX_ROOT/${version}/tests-lib"

	if echo y | "$WP_TEST_ENV_BIN" setup "$version" \
		&& "$WP_TEST_ENV_BIN" test
	then
		RESOLVED=$(grep -m1 "^\$wp_version" "$WP_CORE_DIR/wp-includes/version.php" | sed -E "s/.*'([^']+)'.*/\1/")
		[ -n "$RESOLVED" ] || { echo "wp-version-matrix: could not read a resolved version out of ${WP_CORE_DIR}/wp-includes/version.php" >&2; RESULTS+=("${version}: FAIL (unresolved version)"); FAILED=1; continue; }
		echo "OK: ${version} -> resolved ${RESOLVED}, suite green."
		RESULTS+=("${version} (resolved ${RESOLVED}): PASS")
		KEY=$(version_sort_key "$RESOLVED")
		if [ "$KEY" -gt "$HIGHEST_KEY" ]; then
			HIGHEST_KEY="$KEY"
			HIGHEST="$RESOLVED"
		fi
	else
		RESULTS+=("${version}: FAIL")
		FAILED=1
	fi

	unset WP_CORE_DIR WP_TESTS_DIR
done

echo ""
echo "--- WP version matrix summary ---"
for r in "${RESULTS[@]}"; do
	echo "  $r"
done

[ "$FAILED" -eq 0 ] || die "not every version in the matrix passed - see the summary above."
[ -n "$HIGHEST" ] || die "matrix reported no failures but resolved no version either - this is a bug in this script, not a green run."

echo "MATRIX_HIGHEST_VERSION=${HIGHEST}"
