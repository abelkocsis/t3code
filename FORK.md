# Bitsafe's fork of T3 Code

This fork adds a few things to [T3 Code](https://github.com/pingdotgg/t3code) and
tracks its stable releases. Everything upstream does still works; this file only
covers what is different here.

## Installing

Download the newest `.dmg` from [releases](https://github.com/abelkocsis/t3code/releases)
and drag T3 Code into Applications.

The build is not signed by Apple, so macOS refuses it the first time and says the
app is **damaged**. It is not. Clear the quarantine flag once:

```bash
xattr -dr com.apple.quarantine "/Applications/T3 Code (Alpha).app"
```

Apple's message is the same one it shows for real malware, which is why it looks
alarming. Signing the app would remove it, and costs an Apple developer account.

After that the app updates itself. It checks this repository's releases, not
upstream's, so you stay on the fork.

Apple Silicon only. Ask if you need an Intel build.

## What this fork adds

- **Desktop notifications.** A macOS banner and a dock badge when a thread needs
  you, while T3 Code is not the window you are looking at.
- **Overlay mode.** A small always-on-top window listing what you have not seen
  yet. It hides while you are in T3 Code, and rests as a pill when nothing is
  waiting.
- **Step away mode.** The same window at a size you can read from across the
  room, holding the display awake. Beside the terminal toggle, top right.
- **Start from a GitHub issue.** A button beside "New thread" that searches your
  issues, clones the repository if you have no project for it, and opens a thread
  with the issue text.
- **Usage limits on the context button.** Your session and weekly quota under the
  context window, filling as the quota goes rather than counting down.
- **Settle that settles.** Settling a thread stops whatever it was blocked on
  instead of refusing, and a settled thread never lights up again.
- **Memory follows a fresh workspace.** A worktree used to start with an empty
  agent memory, because Claude Code files memory under the path it ran in.

## Branches

- **`bitsafe`** is this fork's line and its default branch. Releases are cut from
  it.
- **`main`** mirrors upstream and is not used. Do not commit to it.

`bitsafe` is rebased onto each new upstream stable release, so its history is
rewritten. Install releases rather than tracking the branch, unless you are
working on the fork itself.

## Maintaining it

```bash
./scripts/fork-update.sh --check-only   # what would an upstream update take?
./scripts/fork-update.sh                # replay onto the newest stable release
./scripts/fork-release.sh --dry-run     # build a release without publishing it
./scripts/fork-release.sh               # build, tag and publish
```

`fork-update.sh` stops on conflicts and picks up where it left off when you run
it again. It refuses to build if the tests fail.

`fork-release.sh` names each release after the upstream release it carries plus
its own count, `v0.0.39-bitsafe.1`. The number always moves forward, which is what
lets an installed app tell a newer build from an older one.
