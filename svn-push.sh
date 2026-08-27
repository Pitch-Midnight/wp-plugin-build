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
#
#      ALSO clones this repo (wp-plugin-build) itself as the plugin clone's
#      sibling. Every plugin's package.json reaches trs-package.js/
#      trs-deliver.js via `node ../trs-package.js` - a relative path that
#      only resolves because dev-env-wc/pm-plugins/ IS this repo's own
#      checkout, with every plugin cloned inside it. An isolated single-repo
#      clone doesn't have that sibling and never did - this went untested
#      end to end since the 2026-08-16 generalization until 2026-08-19,
#      when testing aoc-wc's release found `npm run package` failing with
#      MODULE_NOT_FOUND. Not aoc-wc-specific: every plugin's package.json
#      uses the same relative path, so this was broken for all of them.
#   2. Runs the WordPress-version test gate (wp-version-matrix.sh) against
#      that clone, BEFORE any build happens - added 2026-08-20, closing
#      todos/pitch-midnight/wp-version-matrix-release-gate.md. aoc-wc 1.0.6
#      shipped with README.txt still claiming "Tested up to: 6.5" and
#      wordpress.org flagging it untested, because nothing in this
#      pipeline had ever run the test suite against anything, gate or not.
#      REFUSES if the plugin has no bin/setup-tests.sh, or if the suite
#      fails against any version in the matrix. WP_VERSION_GATE_SKIP=1
#      skips it - loudly, not silently - for a plugin with no test infra
#      wired yet (woocommerce-cost-of-shipping, as of 2026-08-20).
#   3. Builds the real payload there (npm ci && npm run package) - the
#      same trs-package.js/trs-verify-*.js every other release path uses.
#   4. Verifies the payload's version BEFORE touching your SVN working
#      copy at all (main file present, README present, changelog entry for
#      the version, header version matches), and - if the version gate ran
#      - rewrites "Tested up to:" to the highest WordPress version the
#      matrix actually passed against, so that field is provably what was
#      tested rather than a number someone typed once.
#   5. Confirms the plugin's live Stable-tag convention is "trunk" (all
#      three plugins in this suite use this - checked, not assumed) before
#      proceeding. If a future plugin uses a real version number as its
#      Stable tag, this script refuses rather than silently skip a
#      required bump step it does not implement.
#   6. Syncs the payload into ~/wp-svn-plugins/<slug>/trunk, runs an
#      automated consistency check against the live trunk it is about to
#      replace (new version is actually newer, tree isn't empty, file count
#      hasn't dropped more than a small threshold), and REFUSES rather than
#      committing if any of that looks wrong. Rewritten 2026-08-27 (Parker:
#      "I never meant for this to be a persistent human-only check. What I
#      really wanted... was a diff or a check to indicate that the build
#      was consistent prior to upload") - this used to print `svn status`
#      and block on a human pressing Enter, which was never the actual
#      guarantee wanted; the checks below are that guarantee, and they run
#      unattended. `svn status trunk` is still printed as a log, just no
#      longer something a human has to clear before the script proceeds.
#      This is what 08-build-and-release-pipeline.md's "wordpress.org SVN
#      publishing" section already specified (fail closed on an empty tree
#      or a large file-count drop versus current trunk) - it was designed
#      before this script existed but never actually built until now.
#   7. Cuts the version tag, using each plugin's own existing tag-naming
#      convention (most are bare `1.2.3`; aoc-wc's SVN tags are `v1.2.3`,
#      confirmed against its actual tag history, not guessed).
#   8. Tags the matching commit on GitHub as `v<version>` (always this
#      form, regardless of the SVN tag's own prefix) and pushes it - added
#      2026-08-19 so a real wordpress.org release leaves a matching record
#      on GitHub instead of none at all. Every plugin's
#      .github/workflows/release.yml already builds and publishes a GitHub
#      Release on a `v*` tag push; nothing pushed one before this. Skips,
#      rather than overwrites, if that tag already exists.
#
# Runs unattended once the consistency check passes - no prompt, no pause.
# The SVN commits use whatever credential `svn` already has cached for
# plugins.svn.wordpress.org (macOS Keychain-backed; authenticate once
# interactively and it persists), and the version gate (unless skipped)
# reuses your ~/.config/wp-tests/env credential per wp-test-env.sh. Nothing
# here echoes or stores either. Set SVN_PUSH_DRY_RUN=1 to run every check
# and print what would happen without touching SVN or GitHub.

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

# wordpress.org's SVN read endpoint is intermittently flaky - two separate
# `svn cat` calls each failed transiently on a single run while this file
# was being tested 2026-08-27 (retrying the exact same command by hand
# immediately after succeeded both times). Under `set -e` an unretried,
# unexplained transient failure here kills the whole script with no message
# at all - unacceptable for something meant to run unattended, and it would
# read as "the consistency check found a real problem" when it found
# nothing at all. Retries 3 times with a short backoff; REFUSES with a
# clear, specific message only after all three fail for real.
svn_cat_retry() {
	local url="$1" attempt out
	for attempt in 1 2 3; do
		if out=$(svn cat "$url" 2>&1); then
			printf '%s\n' "$out"
			return 0
		fi
		echo "svn cat ${url} failed (attempt ${attempt}/3) - retrying in 3s..." >&2
		echo "${out}" >&2
		sleep 3
	done
	echo "REFUSING: svn cat ${url} failed 3 times - this is a live SVN read failure, not a consistency finding. Check network/SVN access before re-running." >&2
	return 1
}

REMOTE_URL=$(git -C "$PLUGIN_SRC" remote get-url origin)
# Derive owner/repo from the actual remote rather than assuming - repos moved
# from the personal `theritesite` account to the `Pitch-Midnight` org (and the
# account itself was renamed to `pitchmidnight`) on 2026-08-16. GitHub's
# rename/transfer redirect currently still resolves the old owner name, which
# is why this was not caught sooner - but a redirect is not a guarantee, and
# hardcoding the pre-move owner here was already stale the day this script
# was generalized.
REPO_NWO=$(echo "$REMOTE_URL" | sed -E 's#^(git@github\.com:|https://github\.com/)##; s#\.git$##')
REPO_SLUG=$(basename "$REPO_NWO")
DEFAULT_BRANCH=$(gh repo view "$REPO_NWO" --json defaultBranchRef -q .defaultBranchRef.name)

BUILD=$(mktemp -d)

echo "--- cloning the shared build tooling (this repo, wp-plugin-build) into"
echo "    the build root, so the plugin clone below has the sibling"
echo "    trs-package.js/trs-deliver.js its package.json expects at '../' ---"
git clone --quiet --depth 1 git@github.com:Pitch-Midnight/wp-plugin-build.git "$BUILD"

echo "--- cloning a fresh, isolated copy of ${REPO_SLUG}@${DEFAULT_BRANCH}"
echo "    (not touching your shared dev-env-wc checkout, whatever branch"
echo "    it happens to be on) ---"
git clone --quiet --depth 1 --branch "$DEFAULT_BRANCH" "$REMOTE_URL" "$BUILD/src"
cd "$BUILD/src"

echo ""
echo "--- WordPress-version test gate (before any build happens) ---"
TESTED_UP_TO=""
if [ "${WP_VERSION_GATE_SKIP:-0}" = "1" ]; then
	echo "SKIPPING (WP_VERSION_GATE_SKIP=1): this release is NOT gated on the"
	echo "test suite passing against any WordPress version, and 'Tested up"
	echo "to' will NOT be auto-updated below. Use only for a plugin with no"
	echo "test infra wired yet - see wp-version-matrix-release-gate.md."
else
	MATRIX_LOG=$(mktemp)
	"$BUILD/wp-version-matrix.sh" "$BUILD/src" | tee "$MATRIX_LOG"
	TESTED_UP_TO=$(sed -n 's/^MATRIX_HIGHEST_VERSION=//p' "$MATRIX_LOG" | tail -1)
	rm -f "$MATRIX_LOG"
	[ -n "$TESTED_UP_TO" ] || { echo "REFUSING: version gate produced no resolved version to record."; exit 1; }
	echo "OK: version gate green, highest resolved version ${TESTED_UP_TO}."
fi

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

if [ -n "$TESTED_UP_TO" ]; then
	echo ""
	echo "--- updating 'Tested up to' to ${TESTED_UP_TO} (version-gate result) ---"
	CURRENT_TESTED=$(grep -im1 "^Tested up to:" "$PAYLOAD_SRC/README.txt" | sed -E 's/^Tested up to:[[:space:]]*//I' | tr -d '[:space:]')
	echo "was: ${CURRENT_TESTED:-<none>} -> now: ${TESTED_UP_TO}"
	sed -i '' -E "s/^(Tested up to:)[[:space:]]*.*/\1      ${TESTED_UP_TO}/" "$PAYLOAD_SRC/README.txt"
	grep -qm1 "^Tested up to:[[:space:]]*${TESTED_UP_TO}$" "$PAYLOAD_SRC/README.txt" \
		|| { echo "REFUSING: 'Tested up to' rewrite did not take"; exit 1; }
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
STABLE_TAG=$(svn_cat_retry "https://plugins.svn.wordpress.org/${SLUG}/trunk/README.txt" \
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

echo ""
echo "--- confirming the new version is actually newer than what's live ---"
LIVE_VERSION=$(svn_cat_retry "https://plugins.svn.wordpress.org/${SLUG}/trunk/${MAIN_FILE}" \
	| grep -im1 -E "^[[:space:]]*\*?[[:space:]]*Version:" \
	| sed -E 's/^[[:space:]]*\*?[[:space:]]*Version:[[:space:]]*//I' | tr -d '[:space:]')
if [ -z "$LIVE_VERSION" ]; then
	echo "REFUSING: could not read a Version: line from the live trunk's ${MAIN_FILE}."
	exit 1
fi
HIGHER=$(printf '%s\n%s\n' "$LIVE_VERSION" "$VERSION" | sort -V | tail -n1)
if [ "$HIGHER" != "$VERSION" ] || [ "$LIVE_VERSION" = "$VERSION" ]; then
	echo "REFUSING: live trunk is already at ${LIVE_VERSION}; this build is ${VERSION}, which is not newer."
	echo "This is exactly the re-run case Guardrail 13 asks for a no-op on, not a re-commit -"
	echo "see 08-build-and-release-pipeline.md's 'wordpress.org SVN publishing' section."
	exit 1
fi
echo "OK: live trunk is ${LIVE_VERSION}, this build is ${VERSION} - a real forward step."

cd "$WC"

echo ""
echo "--- bringing your working copy current ---"
svn update trunk

# Snapshot the file count BEFORE the sync overwrites anything, so the
# consistency check below has something to compare the new tree against.
PRE_SYNC_FILE_COUNT=$(find trunk -type f -not -path '*/.svn/*' | wc -l | tr -d ' ')

echo ""
echo "--- syncing the verified payload into trunk ---"
rsync -rc --delete --exclude='.svn' "$PAYLOAD_SRC/" trunk/

echo ""
echo "--- diff: what this push changes (logged, not gated on anything) ---"
svn status trunk

echo ""
echo "--- automated consistency check against the trunk this replaces ---"
echo "This is the check 08-build-and-release-pipeline.md's 'wordpress.org SVN"
echo "publishing' section specified - fail closed on an empty tree or a large"
echo "file-count drop - run unattended rather than left as a human's judgment"
echo "call on the diff above. Rewritten 2026-08-27 per Parker: the diff was"
echo "always meant to back a check, not to gate on a person reading it."
POST_SYNC_FILE_COUNT=$(find trunk -type f -not -path '*/.svn/*' | wc -l | tr -d ' ')
echo "trunk file count: ${PRE_SYNC_FILE_COUNT} -> ${POST_SYNC_FILE_COUNT}"

if [ "$POST_SYNC_FILE_COUNT" -eq 0 ]; then
	echo "REFUSING: the synced tree is empty. Not committing an empty trunk."
	exit 1
fi

MAX_FILE_DROP_PERCENT="${MAX_FILE_DROP_PERCENT:-20}"
if [ "$PRE_SYNC_FILE_COUNT" -gt 0 ]; then
	DROP_PERCENT=$(( (PRE_SYNC_FILE_COUNT - POST_SYNC_FILE_COUNT) * 100 / PRE_SYNC_FILE_COUNT ))
	if [ "$DROP_PERCENT" -gt "$MAX_FILE_DROP_PERCENT" ]; then
		echo "REFUSING: file count dropped ${DROP_PERCENT}% (${PRE_SYNC_FILE_COUNT} -> ${POST_SYNC_FILE_COUNT}),"
		echo "more than the ${MAX_FILE_DROP_PERCENT}% threshold (MAX_FILE_DROP_PERCENT to override)."
		echo "A real deletion should show up named in trsPackage.include or the changelog above -"
		echo "a shrink this size unexplained looks like a build gone wrong, not a real release."
		exit 1
	fi
fi
echo "OK: file-count change is within the ${MAX_FILE_DROP_PERCENT}% threshold."

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

DRY_RUN="${SVN_PUSH_DRY_RUN:-0}"
if [ "$DRY_RUN" = "1" ]; then
	echo ""
	echo "SVN_PUSH_DRY_RUN=1: every check above passed. Stopping here without"
	echo "touching SVN or GitHub - trunk was NOT committed, no tag was cut."
	rm -rf "$BUILD"
	exit 0
fi

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

# GITHUB TAG - added 2026-08-19 (Parker: "github does not get a tagged
# release... we should have the releases that become the tagged release in
# SVN match in github"). Every plugin ships .github/workflows/release.yml,
# which builds and publishes a GitHub Release on any push of a `v*` tag -
# but nothing before this pushed one, so a real wordpress.org release left
# no matching record on GitHub and never fired that workflow. The SVN tag
# prefix above is per-plugin (aoc-wc's is `v` because its existing SVN tag
# history uses it); the GitHub tag is always `v${VERSION}` regardless,
# because that is the literal pattern release.yml's trigger matches.
GH_TAG="v${VERSION}"
echo ""
echo "--- tagging the matching GitHub release: ${GH_TAG} on ${REPO_NWO} ---"
if git ls-remote --tags "$REMOTE_URL" "refs/tags/${GH_TAG}" | grep -q "refs/tags/${GH_TAG}$"; then
	echo "SKIPPING: ${GH_TAG} already exists on ${REPO_NWO} - not re-tagging."
	echo "If that tag is stale (points at an older commit than what was just"
	echo "pushed to SVN), that is worth investigating by hand, not silently"
	echo "overwritten here."
else
	git -C "$BUILD/src" tag "$GH_TAG"
	git -C "$BUILD/src" push origin "$GH_TAG"
	echo "OK: pushed ${GH_TAG} - release.yml's tag trigger will build and"
	echo "    publish the matching GitHub Release."
fi

echo ""
echo "Done. Verify at: https://plugins.trac.wordpress.org/log/${SLUG}/"
echo "  and: https://github.com/${REPO_NWO}/releases"
rm -rf "$BUILD"
