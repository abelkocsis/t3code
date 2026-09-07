#!/usr/bin/env bash
#
# Replay this fork's commits onto the newest upstream stable release.
#
# Semi-manual on purpose: it does the mechanical parts and stops wherever a
# person has to decide something. Run it again after resolving conflicts and it
# picks up where it left off.
#
#   scripts/fork-update.sh              # rebase, check, and stop before building
#   scripts/fork-update.sh --build      # also build the macOS DMG once checks pass
#   scripts/fork-update.sh --check-only # report what an update would take, change nothing
#
set -euo pipefail

BRANCH="feature/desktop-notifications"
# The tag this branch is currently based on. The script rewrites this line
# after a successful rebase, so the next run knows which range to replay.
BASE_TAG="v0.0.39"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

BUILD=0
CHECK_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --build) BUILD=1 ;;
    --check-only) CHECK_ONLY=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

# vp is a shell function in interactive shells only, so reach the real binary.
export PATH="$HOME/.local/share/vite-plus/bin:$PATH"
command -v vp >/dev/null || { echo "vp not found. See docs/internals/scripts.md" >&2; exit 1; }

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# ── Where are we? ────────────────────────────────────────────────────────────
say "Fetching upstream…"
git fetch upstream --tags --quiet

LATEST_TAG="$(git tag --sort=-creatordate | grep -vE 'nightly|preview' | head -1)"
[ -n "$LATEST_TAG" ] || die "No stable tag found."

# Already current is not the same as nothing to do: --build still has a build
# to run, which is the whole point of asking for it.
UP_TO_DATE=0
if [ "$LATEST_TAG" = "$BASE_TAG" ]; then
  UP_TO_DATE=1
  say "Already on the newest stable release ($BASE_TAG)."
  if [ "$BUILD" != "1" ]; then
    exit 0
  fi
fi

if [ "$UP_TO_DATE" = "1" ]; then
  say "Skipping the replay and going straight to the build."
else
AHEAD="$(git rev-list --count "$BASE_TAG..$LATEST_TAG")"
OURS="$(git rev-list --count "$BASE_TAG..$BRANCH")"
say "$BASE_TAG → $LATEST_TAG  ($AHEAD upstream commits, $OURS of ours to replay)"

# Files we changed that upstream also changed are where conflicts come from.
say "Our files that also changed upstream:"
comm -12 \
  <(git diff --name-only "$BASE_TAG..$BRANCH" | sort) \
  <(git diff --name-only "$BASE_TAG..$LATEST_TAG" | sort) \
  | sed 's/^/  /' || true
fi

if [ "$CHECK_ONLY" = "1" ]; then
  say "Check only. Nothing changed."
  exit 0
fi

# ── Rebase ───────────────────────────────────────────────────────────────────
if [ "$UP_TO_DATE" = "1" ]; then
  : # Nothing to replay.
elif [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ]; then
  say "A rebase is already in progress; continuing it."
  git rebase --continue || die "Still conflicted. Resolve, 'git add' them, then re-run this script."
else
  [ -z "$(git status --porcelain --untracked-files=no)" ] \
    || die "Working tree is dirty. Commit or stash first, then re-run."
  git checkout --quiet "$BRANCH"
  # A safety net: the branch as it was, in case the replay goes wrong.
  BACKUP="backup/${BRANCH##*/}-$(date +%Y%m%d-%H%M%S)"
  git branch "$BACKUP"
  say "Branch backed up as $BACKUP"
  say "Replaying onto ${LATEST_TAG}…"
  if ! git rebase --onto "$LATEST_TAG" "$BASE_TAG" "$BRANCH"; then
    printf '\n\033[33m%s\033[0m\n' "Conflicts. Resolve them, 'git add' each file, then re-run this script."
    git --no-pager diff --name-only --diff-filter=U | sed 's/^/  /'
    exit 1
  fi
fi

# ── Prove it ─────────────────────────────────────────────────────────────────
# A clean replay is not a working one: this fork reverses an upstream invariant
# in apps/server/src/orchestration/decider.ts, and a silent merge there would
# leave settle behaviour half-changed. The tests are what catch that.
say "Installing dependencies (upstream may have changed them)…"
vp install

say "Typechecking…"
vp run --filter t3 --filter @t3tools/web --filter @t3tools/desktop \
       --filter @t3tools/client-runtime --filter @t3tools/contracts \
       --filter @t3tools/shared typecheck \
  || die "Typecheck failed. The replay landed but the result is wrong."

say "Running the tests that cover this fork's changes…"
vp test run \
  apps/server/src/orchestration/ \
  packages/client-runtime/src/state/ \
  apps/web/src/notifications/ \
  apps/web/src/components/Sidebar.logic.test.ts \
  apps/desktop/src/window/OverlayWindowHtml.test.ts \
  apps/desktop/src/settings/DesktopClientSettings.test.ts \
  || die "Tests failed. Do not install this build."

if [ "$UP_TO_DATE" = "0" ]; then
  # Record the new base so the next run replays the right range.
  sed -i '' "s/^BASE_TAG=\".*\"$/BASE_TAG=\"$LATEST_TAG\"/" "$REPO_ROOT/scripts/fork-update.sh"
  say "Checks passed. Base tag recorded as $LATEST_TAG — commit this script's change."
else
  say "Checks passed."
fi

# ── Build ────────────────────────────────────────────────────────────────────
if [ "$BUILD" = "1" ]; then
  say "Building the macOS DMG…"
  node scripts/build-desktop-artifact.ts --platform mac --target dmg --arch arm64
  cat <<EOF

Installed by hand, because replacing a running application should be deliberate:

  1. Quit T3 Code (Cmd-Q).
  2. open $REPO_ROOT/release/
  3. Drag "T3 Code (Alpha)" onto Applications, replacing the old one.
  4. xattr -dr com.apple.quarantine "/Applications/T3 Code (Alpha).app"

The build is unsigned, so step 4 is required or macOS calls it damaged.
EOF
else
  say "Not building. Re-run with --build when you want the DMG."
fi
