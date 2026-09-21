# Daily summary

## Write your standup in one click

**Daily summary** collects what you did on a day and writes it up as bullets you can paste into
a standup message. Open it with the clipboard icon in the top-right corner, next to the step-away
control, or from the command palette.

The panel opens on the last day the server recorded work. On a Monday that is Friday, not an
empty Sunday.

## Where the summary comes from

The server reads four sources for the day, on the machine it runs on:

- The T3 Code threads you ran, with your messages and the files the turns changed.
- The commits in every project's working directory.
- The pull requests you authored that moved that day.
- The Claude Code sessions you ran in a terminal.

The model only ever sees what the server collected, and the server drops any bullet that names a
repository or a pull request number the day's evidence never showed. The summary covers one
environment. Work on another machine needs that machine's own summary.

## Choosing what goes in

Hover a bullet to reveal its controls. The **remove** button takes a bullet out. A removed bullet
stays in the list, struck through, so you can put it back. A later regeneration on the same day
keeps your choice and does not report that work again.

Drag a bullet by its handle to reorder the list. The order you set is the order **Copy** gives
you, so you can lead with the work that matters most.

Type into the box at the bottom to add a bullet the summary missed. Your own bullets survive a
regeneration word for word.

## Other days

Use the arrows in the panel header to step to another date. Another day shows its stored summary
if it has one. If it does not, the panel offers a button rather than writing one on its own, so
browsing back through the week costs you nothing.

**Regenerate** rewrites the day on screen. It spends provider tokens, so it only ever runs when
you press it, or the first time you open a day that has work and no summary yet.

## Copying it out

**Copy** puts the kept bullets on your clipboard and saves them as the day's final version, so the
panel shows what you actually sent when you come back to it.

No summary reaches another day. Each day is written from that day's evidence alone, which is what
keeps last week's work out of today's update.

T3 Code never posts to Slack or anywhere else. Copying and pasting stays your decision.

## Which model writes it

The summary uses the same model as T3 Code's other short generations, such as commit messages and
thread titles. Change it under **Settings → Source control → Text generation**.

The writing style set on that screen applies to commits and change requests only. The summary
follows its own style rules.
