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
# The Homebrew tap that pins this fork's cask to a version and a checksum.
TAP_REPOSITORY="DLC-link/homebrew-tap"
CASK_PATH="Casks/t3-code-bitsafe.rb"

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
BASE_TAG_FILE="apps/web/src/upstreamBase.ts"
BASE_TAG="$(sed -n 's/^export const UPSTREAM_BASE_TAG = "\(.*\)";$/\1/p' "$BASE_TAG_FILE")"
[ -n "$BASE_TAG" ] || die "Could not read UPSTREAM_BASE_TAG from ${BASE_TAG_FILE}."
BASE_VERSION="${BASE_TAG#v}"

if [ -z "$VERSION" ]; then
  # Count what this base already shipped, so the number always moves forward
  # and always says which upstream release it carries.
  PREVIOUS="$(git tag --list "v${BASE_VERSION}-bitsafe.*" | wc -l | tr -d ' ')"
  VERSION="${BASE_VERSION}-bitsafe.$((PREVIOUS + 1))"
fi
TAG="v${VERSION}"

# A tag on its own is not a release: publishing can fail after tagging, and
# re-running then has to finish the job rather than refuse. Only a release that
# already exists means this version is done.
TAG_EXISTS=0
if git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
  gh release view "$TAG" --repo "$UPDATE_REPOSITORY" >/dev/null 2>&1 \
    && die "${TAG} is already released. Pass a version explicitly to cut another."
  TAG_EXISTS=1
  say "Tag ${TAG} exists with no release behind it; finishing that release."
fi

say "Releasing ${TAG} from ${BRANCH} (upstream base ${BASE_TAG})"

# ── Prove it ─────────────────────────────────────────────────────────────────
say "Typechecking…"
vp run --filter t3 --filter @t3tools/web --filter @t3tools/desktop \
       --filter @t3tools/client-runtime --filter @t3tools/contracts \
       --filter @t3tools/shared typecheck \
  || die "Typecheck failed. Nothing was built or published."

say "Running the tests that cover this fork's changes…"
vp test run \
  apps/server/src/fork/ \
  apps/server/src/slack/ \
  apps/server/src/standup/ \
  apps/server/src/todos/ \
  apps/server/src/sourceControl/SourceControlIssueService.test.ts \
  apps/server/src/provider/providerWorkspaceState.test.ts \
  apps/server/src/provider/ProviderWorkspaceStateService.test.ts \
  apps/server/src/persistence/Migrations.test.ts \
  packages/contracts/src/factory.test.ts \
  packages/contracts/src/slack.test.ts \
  packages/contracts/src/settings.test.ts \
  packages/shared/src/usageLimits.test.ts \
  packages/client-runtime/src/state/threadAttention.test.ts \
  packages/client-runtime/src/state/overlayVisibility.test.ts \
  apps/web/src/components/Sidebar.logic.test.ts \
  apps/web/src/components/Sidebar.drag.test.ts \
  apps/web/src/components/factory/ \
  apps/web/src/components/chat/quickReplyVisibility.test.ts \
  apps/web/src/upstreamRelease.test.ts \
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

# The old cask in abelkocsis/homebrew-t3code downloads
# releases/latest/download/T3-Code-arm64.dmg. That redirect only resolves a
# fixed asset name, so every release also carries the dmg under this name
# until everyone has moved to the dlc-link/tap cask.
STABLE_DMG="release/T3-Code-arm64.dmg"
cp -f "$DMG" "$STABLE_DMG"
ASSETS+=("$STABLE_DMG")

if [ "$DRY_RUN" = "1" ]; then
  say "Dry run. Built ${DMG} and left the tag and the release alone."
  exit 0
fi

# ── Publish ──────────────────────────────────────────────────────────────────
if [ "$TAG_EXISTS" = "0" ]; then
  say "Tagging ${TAG}…"
  git tag -a "$TAG" -m "T3 Code ${VERSION} (fork of ${BASE_TAG})"
fi
git push origin "$BRANCH"
git push origin "$TAG"

say "Publishing the release…"
# --repo is not optional here. This checkout has an `upstream` remote as well,
# and gh resolves a fork to its parent by default, so without it the release is
# attempted against pingdotgg/t3code and refused.
gh release create "$TAG" \
  --repo "$UPDATE_REPOSITORY" \
  --title "T3 Code ${VERSION}" \
  --notes "Bitsafe's fork of T3 Code, built on upstream ${BASE_TAG}.

## Installing

1. Download the \`.dmg\` below and drag T3 Code into Applications.
2. The build is unsigned, so macOS calls it damaged until you clear the
   quarantine flag once:

   \`\`\`
   xattr -dr com.apple.quarantine \"/Applications/T3 Code (Beta).app\"
   \`\`\`

Later versions install themselves: the app checks this repository's releases
and offers the update." \
  "$DMG" "$ZIP" "$FEED" ${ASSETS[@]+"${ASSETS[@]}"}

say "Published ${TAG}. Colleagues on an earlier build will be offered it."

# ── Homebrew ─────────────────────────────────────────────────────────────────
# The tap's main branch requires a signed commit and one approving review, so
# the cask bump is a pull request. The contents API commits as the gh user and
# GitHub signs that commit.
say "Opening the cask pull request in ${TAP_REPOSITORY}…"
SHA256="$(shasum -a 256 "$DMG" | cut -d' ' -f1)"
CASK_BRANCH="release/cask-${VERSION}"
UPDATED_CASK="$(mktemp)"
BASE_SHA="$(gh api "repos/${TAP_REPOSITORY}/branches/main" --jq .commit.sha)"
CASK_FILE_SHA="$(gh api "repos/${TAP_REPOSITORY}/contents/${CASK_PATH}?ref=${BASE_SHA}" --jq .sha)"
gh api "repos/${TAP_REPOSITORY}/contents/${CASK_PATH}?ref=${BASE_SHA}" --jq .content | base64 -d > "$UPDATED_CASK"
sed -i '' -E \
  -e "s|^  version \".*\"$|  version \"${VERSION}\"|" \
  -e "s|^  sha256 \".*\"$|  sha256 \"${SHA256}\"|" \
  "$UPDATED_CASK"
for line in "version \"${VERSION}\"" "sha256 \"${SHA256}\""; do
  grep -qF "  $line" "$UPDATED_CASK" || die "${CASK_PATH} has no line matching: $line"
done
gh api "repos/${TAP_REPOSITORY}/git/refs" -f ref="refs/heads/${CASK_BRANCH}" -f sha="$BASE_SHA" > /dev/null
gh api --method PUT "repos/${TAP_REPOSITORY}/contents/${CASK_PATH}" -f branch="$CASK_BRANCH" \
  -f sha="$CASK_FILE_SHA" -f message="Update the T3 Code (BitSafe) cask to ${VERSION}" \
  -f content="$(base64 -i "$UPDATED_CASK")" > /dev/null
gh pr create --repo "$TAP_REPOSITORY" --base main --head "$CASK_BRANCH" \
  --title "Update the T3 Code (BitSafe) cask to ${VERSION}" \
  --body "Points the cask at the [${TAG} release](https://github.com/${UPDATE_REPOSITORY}/releases/tag/${TAG}). After it merges, \`brew upgrade --cask t3-code-bitsafe\` installs it."
rm -f "$UPDATED_CASK"

say "Cask pull request opened. It needs one approving review before brew sees ${VERSION}."
