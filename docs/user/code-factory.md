# Code factory

The Factory page runs tasks on their own: an agent takes an issue through
spec, build and review, opens a pull request, and the server then keeps the
pull request rebased and green while reviewers look at it. You step in only
at the gates: a question from the agent, the review request, and the merge.

Open it from the factory button at the bottom of the sidebar, or run **Open
factory** from the command palette.

## Start a task

Paste a GitHub issue link, a pull request link, or describe the task in the
field at the top of the page. T3 Code picks the project from the repository in
the link; when it cannot, pick the project yourself. Choose a model and effort
if the project default is not what you want, then press **Run the
code-factory**. The task gets its own worktree off the project's current
branch.

The first message comes from the prompt template in **Settings → General →
Code factory**. `{{input}}` stands for the task input.

To run the factory on a thread that already exists, choose **Add to Factory**
from the thread's menu. A thread with a pull request starts at the review
stage; otherwise the agent works out where the task stands. **Remove from
Factory** takes a task off the page and keeps the thread.

## Follow a task

Each row shows the phase, how long the task has been in it, and whether it
waits on you. Select a row to see the agent's open question with its options,
its last reply, and a reply box. Tasks can be grouped in folders and dragged
between them.

From a row's menu you can snooze the task, put it to sleep until another pull
request merges, move it to a phase by hand when the agent lost track, or
archive it.

## Review and merge

When the agent finishes, the task reads **Ready for review**. Copy the review
request for your reviewers and press **Mark under review**. From then on the
server watches the pull request: a new review, comment, failed check or stale
base goes to the agent, which fixes it or pushes back and reports under the
pull request. An approved, green pull request reads **Ready to merge**; press
**Merge** to merge it with the project's merge method.

## Token saving

Turn on **Token saving** at the top of the page to keep watching pull requests
without spending tokens. Review work is held on the task with a **Start work**
button instead of going to the agent at once. Turning it off sends the held
work.
