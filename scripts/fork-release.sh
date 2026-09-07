#!/usr/bin/env bash
#
# Cut a release of this fork: build the macOS app, tag the commit, and publish
# the files to this fork's GitHub releases so installed copies update
# themselves.
#
#   scripts/fork-release.sh              # next release of the current base
#   scripts/fork-release.sh 0.0.39-bitsafe.3   # a version you choose
#   scripts/fork-release.sh --dry-run    # build and stop, publish nothing
#
set -euo pipefail

BRANCH="bitsafe"
# Where installed copies look for updates. Building without this produces an
# app with no update feed at all, which is the difference between colleagues
# updating themselves and colleagues re-downloading by hand forever.
UPDATE_REPOSITORY="abelkocsis/t3code"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

export PATH="$HOME/.local/share/vite-plus/bin:$PATH"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

DRY_RUN=0
VERSION=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -*) die "unknown option: $arg" ;;
    *) VERSION="$arg" ;;
  esac
done

command -v gh >/dev/null || die "GitHub CLI (gh) is required to publish a release."
command -v vp >/dev/null || die "vp not found. See docs/internals/scripts.md"

# ── Where are we? ────────────────────────────────────────────────────────────
[ "$(git rev-parse --abbrev-ref HEAD)" = "$BRANCH" ] \
  || die "Releases are cut from '$BRANCH'. Switch to it first."
[ -z "$(git status --porcelain --untracked-files=no)" ] \
  || die "Working tree is dirty. Commit or stash first."

# The upstream release this fork currently sits on. `fork-update.sh` rewrites
# it after every successful replay, so it is always the real base.
BASE_TAG="$(sed -n 's/^BASE_TAG="\(.*\)"$/\1/p' scripts/fork-update.sh)"
[ -n "$BASE_TAG" ] || die "Could not read BASE_TAG from scripts/fork-update.sh."
BASE_VERSION="${BASE_TAG#v}"

if [ -z "$VERSION" ]; then
  # Count what this base already shipped, so the number always moves forward
  # and always says which upstream release it carries.
  PREVIOUS="$(git tag --list "v${BASE_VERSION}-bitsafe.*" | wc -l | tr -d ' ')"
  VERSION="${BASE_VERSION}-bitsafe.$((PREVIOUS + 1))"
fi
TAG="v${VERSION}"

git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null \
  && die "Tag ${TAG} already exists. Pass a version explicitly to override."

say "Releasing ${TAG} from ${BRANCH} (upstream base ${BASE_TAG})"

# ── Prove it ─────────────────────────────────────────────────────────────────
say "Typechecking…"
vp run --filter t3 --filter @t3tools/web --filter @t3tools/desktop \
       --filter @t3tools/client-runtime --filter @t3tools/contracts \
       --filter @t3tools/shared typecheck \
  || die "Typecheck failed. Nothing was built or published."

say "Running the tests that cover this fork's changes…"
vp test run \
  apps/server/src/orchestration/ \
  apps/server/src/sourceControl/gitHubIssues.test.ts \
  apps/server/src/sourceControl/SourceControlIssueService.test.ts \
  apps/server/src/provider/providerWorkspaceState.test.ts \
  apps/server/src/provider/ProviderWorkspaceStateService.test.ts \
  packages/client-runtime/src/state/ \
  apps/web/src/notifications/ \
  apps/web/src/components/issues/ \
  apps/web/src/components/Sidebar.logic.test.ts \
  apps/desktop/src/window/ \
  apps/desktop/src/settings/DesktopClientSettings.test.ts \
  || die "Tests failed. Nothing was built or published."

# ── Build ────────────────────────────────────────────────────────────────────
say "Building ${VERSION} for macOS (arm64)…"
T3CODE_DESKTOP_UPDATE_REPOSITORY="$UPDATE_REPOSITORY" \
  node scripts/build-desktop-artifact.ts \
    --platform mac --target dmg --arch arm64 --build-version "$VERSION" \
  || die "Build failed. Nothing was published."

DMG="release/T3-Code-${VERSION}-arm64.dmg"
ZIP="release/T3-Code-${VERSION}-arm64.zip"
FEED="release/latest-mac.yml"
[ -f "$DMG" ] || die "Expected ${DMG}, which the build did not produce."
# Without the feed file an installed app has nowhere to look, so a release
# missing it silently strands everyone on the version they already have.
[ -f "$FEED" ] || die "No ${FEED}. The update feed was not generated; do not publish this."

# Named one by one rather than globbed: `release/` keeps every build ever made,
# so a glob would attach last month's files to this release. The expansion below
# is written the long way because macOS ships bash 3.2, where `"${ASSETS[@]}"`
# on an empty array is an unbound variable under `set -u`.
ASSETS=()
for extra in "${DMG}.blockmap" "${ZIP}.blockmap"; do
  [ -f "$extra" ] && ASSETS+=("$extra")
done

if [ "$DRY_RUN" = "1" ]; then
  say "Dry run. Built ${DMG} and left the tag and the release alone."
  exit 0
fi

# ── Publish ──────────────────────────────────────────────────────────────────
say "Tagging ${TAG}…"
git tag -a "$TAG" -m "T3 Code ${VERSION} (fork of ${BASE_TAG})"
git push origin "$BRANCH"
git push origin "$TAG"

say "Publishing the release…"
gh release create "$TAG" \
  --title "T3 Code ${VERSION}" \
  --notes "Bitsafe's fork of T3 Code, built on upstream ${BASE_TAG}.

## Installing

1. Download the \`.dmg\` below and drag T3 Code into Applications.
2. The build is unsigned, so macOS calls it damaged until you clear the
   quarantine flag once:

   \`\`\`
   xattr -dr com.apple.quarantine \"/Applications/T3 Code (Alpha).app\"
   \`\`\`

Later versions install themselves: the app checks this repository's releases
and offers the update." \
  "$DMG" "$ZIP" "$FEED" ${ASSETS[@]+"${ASSETS[@]}"}

say "Published ${TAG}. Colleagues on an earlier build will be offered it."
