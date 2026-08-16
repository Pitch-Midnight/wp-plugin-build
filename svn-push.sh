#!/bin/zsh
#
# Manual, local wordpress.org SVN push for any plugin in the TRS suite that
# is already confirmed live on .org. Generalized 2026-08-16 from a one-off
# script written for woo-cost-of-shipping's reopen (see
# parker-context/todos/pitch-midnight/cost-of-shipping-reopen-request-draft.md).
#
# DELIBERATELY NOT GITHUB ACTIONS (yet). 08-build-and-release-pipeline.md's
# "wordpress.org SVN publishing" section proposes a tag-triggered CI job;
# this script is the local-only version of the same idea, chosen for now
# because it needs no new GitHub secrets, no Environment/reviewer setup, and
# reuses the exact same build/verify scripts either way. See that doc's
# "CI - deferred, not reversed" note for the reasoning and what would flip
# this decision. This is a "not yet," not a "never."
#
# USAGE
#   ./svn-push.sh <plugin-repo-dir>
#
#   <plugin-repo-dir> is the directory name under dev-env-wc/pm-plugins/,
#   e.g.: woocommerce-cost-of-shipping, enhanced-ajax-add-to-cart-wc, aoc-wc
#
# WHAT IT DOES, IN ORDER
#   1. Clones a FRESH, ISOLATED copy of the plugin repo's default branch -
#      never touches or depends on whatever is checked out in the shared
#      dev-env-wc working copy. (Generalizing surfaced a real bug: two of
#      the three plugin repos were NOT on their default branch in the
#      shared checkout when this was written - aoc-wc was on a feature
#      branch, enhanced-ajax-add-to-cart-wc too. Building from "whatever's
#      checked out" would have shipped the wrong code. This script always
#      builds from the actual current default branch, full stop.)
#   2. Builds the real payload there (npm ci && npm run package) - the
#      same trs-package.js/trs-verify-*.js every other release path uses.
#   3. Verifies the payload's version BEFORE touching your SVN working
#      copy at all (main file present, README present, changelog entry for
#      the version, header version matches).
#   4. Confirms the plugin's live Stable-tag convention is "trunk" (all
#      three plugins in this suite use this - checked, not assumed) before
#      proceeding. If a future plugin uses a real version number as its
#      Stable tag, this script refuses rather than silently skip a
#      required bump step it does not implement.
#   5. Syncs the payload into ~/wp-svn-plugins/<slug>/trunk, pauses for you
#      to review `svn status` and `svn diff`, then commits.
#   6. Cuts the version tag, using each plugin's own existing tag-naming
#      convention (most are bare `1.2.3`; aoc-wc's SVN tags are `v1.2.3`,
#      confirmed against its actual tag history, not guessed).
#
# Run this yourself. It prompts for your SVN application password at the
# two commit steps. Nothing here echoes or stores it.

set -euo pipefail

if [ $# -ne 1 ]; then
	echo "usage: $0 <plugin-repo-dir>" >&2
	echo "  e.g.: $0 woocommerce-cost-of-shipping" >&2
	echo "        $0 enhanced-ajax-add-to-cart-wc" >&2
	echo "        $0 aoc-wc" >&2
	exit 1
fi

PLUGIN_DIR_NAME="$1"
SVN_USER="theritesites"
PLUGINS_ROOT="$HOME/claude/pm-dev/dev-env-wc/pm-plugins"
PLUGIN_SRC="${PLUGINS_ROOT}/${PLUGIN_DIR_NAME}"

if [ ! -d "$PLUGIN_SRC/.git" ]; then
	echo "REFUSING: $PLUGIN_SRC is not a git repo"
	exit 1
fi

# Per-plugin SVN tag-naming quirks, checked against real tag history
# (2026-08-16), not assumed. Default is bare (tags/1.2.3). Add a line here
# only after checking `svn ls https://plugins.svn.wordpress.org/<slug>/tags/`
# yourself - do not guess.
tag_prefix_for() {
	case "$1" in
		additional-order-costs-for-woocommerce) echo "v" ;;
		*) echo "" ;;
	esac
}

REMOTE_URL=$(git -C "$PLUGIN_SRC" remote get-url origin)
REPO_SLUG=$(basename -s .git "$REMOTE_URL")
DEFAULT_BRANCH=$(gh repo view "theritesite/${REPO_SLUG}" --json defaultBranchRef -q .defaultBranchRef.name)

echo "--- cloning a fresh, isolated copy of ${REPO_SLUG}@${DEFAULT_BRANCH}"
echo "    (not touching your shared dev-env-wc checkout, whatever branch"
echo "    it happens to be on) ---"
BUILD=$(mktemp -d)
git clone --quiet --depth 1 --branch "$DEFAULT_BRANCH" "$REMOTE_URL" "$BUILD/src"
cd "$BUILD/src"

echo ""
echo "--- building the payload from that clean clone ---"
npm ci --no-audit --no-fund
npm run package

SLUG=$(node -p "require('./package.json').trsPackage.slug")
VERSION=$(node -p "require('./package.json').version")
MAIN_FILE=$(node -p "require('./package.json').trsPackage.mainFile || (require('./package.json').trsPackage.slug + '.php')")
PAYLOAD_SRC="${BUILD}/src/zip_files/${SLUG}"

echo "plugin slug: ${SLUG}"
echo "version:     ${VERSION}"
echo "main file:   ${MAIN_FILE}"

if [ ! -d "$PAYLOAD_SRC" ]; then
	echo "REFUSING: build did not produce $PAYLOAD_SRC"
	exit 1
fi

echo ""
echo "--- verifying the freshly built payload BEFORE touching the SVN"
echo "    working copy at all ---"
test -s "$PAYLOAD_SRC/${MAIN_FILE}" || { echo "REFUSING: main plugin file missing/empty in build output"; exit 1; }
test -s "$PAYLOAD_SRC/README.txt" || { echo "REFUSING: README.txt missing/empty in build output"; exit 1; }
grep -q "^Stable tag:" "$PAYLOAD_SRC/README.txt" || { echo "REFUSING: no Stable tag line in build output"; exit 1; }
grep -qm1 "^= ${VERSION} =" "$PAYLOAD_SRC/README.txt" \
	|| { echo "REFUSING: build output's README.txt has no ${VERSION} changelog entry"; exit 1; }
grep -qE "^\s*\*?\s*Version:\s*${VERSION}\b" "$PAYLOAD_SRC/${MAIN_FILE}" \
	|| { echo "REFUSING: build output's plugin header version does not say ${VERSION}"; exit 1; }
echo "OK: freshly built payload is consistent with ${VERSION}."

WC="$HOME/wp-svn-plugins/${SLUG}"
if [ ! -d "$WC/.svn" ]; then
	echo "REFUSING: $WC is not an SVN working copy."
	echo "This script syncs an existing checkout, it does not create one -"
	echo "checking out a plugin's full SVN history is a deliberate one-time"
	echo "act. Run: svn checkout https://plugins.svn.wordpress.org/${SLUG} $WC"
	exit 1
fi

echo ""
echo "--- confirming this plugin's Stable tag convention is 'trunk'"
echo "    (checked, not assumed - all three known plugins use this) ---"
STABLE_TAG=$(svn cat "https://plugins.svn.wordpress.org/${SLUG}/trunk/README.txt" 2>&1 \
	| grep -im1 "^Stable tag:" | sed -E 's/^Stable tag:[[:space:]]*//I' | tr -d '[:space:]')
if [ "$STABLE_TAG" != "trunk" ]; then
	echo "REFUSING: live Stable tag is '${STABLE_TAG}', not 'trunk'."
	echo "This plugin needs an explicit Stable-tag-bump step, which this"
	echo "script does not implement - see 08-build-and-release-pipeline.md's"
	echo "'wordpress.org SVN publishing' section for why that step is kept"
	echo "separate and reviewer-gated rather than automatic."
	exit 1
fi
echo "OK: Stable tag is 'trunk' - the trunk commit below is the whole push."

cd "$WC"

echo ""
echo "--- bringing your working copy current ---"
svn update trunk

echo ""
echo "--- syncing the verified payload into trunk ---"
rsync -rc --delete --exclude='.svn' "$PAYLOAD_SRC/" trunk/

echo ""
echo "--- diff: what this push would change (review before continuing) ---"
svn status trunk

echo ""
echo "--- re-verifying against trunk itself, now that the sync has happened"
echo "    (belt and suspenders) ---"
cd trunk
test -s "$MAIN_FILE" || { echo "REFUSING: main plugin file missing/empty"; exit 1; }
test -s README.txt || { echo "REFUSING: README.txt missing/empty"; exit 1; }
grep -qm1 "^= ${VERSION} =" README.txt || { echo "REFUSING: no ${VERSION} changelog entry in README.txt"; exit 1; }
grep -qE "^\s*\*?\s*Version:\s*${VERSION}\b" "$MAIN_FILE" \
	|| { echo "REFUSING: plugin header version does not say ${VERSION}"; exit 1; }
echo "OK."

echo ""
echo "Review the 'svn status' output above carefully."
echo "Press Enter to add/remove and commit trunk, or Ctrl-C to abort."
read -r _

svn add --force . --quiet
svn status | awk '/^!/ {print $2}' | xargs -r svn rm

svn commit -m "${VERSION}" --username "$SVN_USER"

TAG_PREFIX=$(tag_prefix_for "$SLUG")
SVN_REPO="https://plugins.svn.wordpress.org/${SLUG}"
echo ""
echo "--- trunk pushed. Cutting tags/${TAG_PREFIX}${VERSION} ---"
svn cp "$SVN_REPO/trunk" "$SVN_REPO/tags/${TAG_PREFIX}${VERSION}" \
	-m "Tag ${TAG_PREFIX}${VERSION}" \
	--username "$SVN_USER"

echo ""
echo "Done. Verify at: https://plugins.trac.wordpress.org/log/${SLUG}/"
rm -rf "$BUILD"
