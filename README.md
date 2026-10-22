# Worktree Review

A GitHub-style review screen for the git worktrees Claude Code is working in. It runs on
your machine at **http://localhost:4747**. Leave it open and review Claude's work as it
lands, before anything becomes a PR.

- **See everything in one place.** Worktrees are grouped into *Claude is working* (a live
  session is using it), *Recent*, *PR merged* and *Older*. A blue dot means the worktree
  changed since you last reviewed it. Turn on notifications to hear when a session
  finishes work you haven't looked at.
- **Review it like a PR.** The diff covers the branch plus uncommitted and untracked files.
  It's taken against the PR's base, the branch it's stacked on, or `origin/main`, and you can
  change the base. *Mark as reviewed* remembers the exact state, so *Since last review*
  shows only what's new. You can tick off files as viewed.
- **Comment, and Claude gets it.** Click `+` on any line. *Send to Claude* delivers the
  review to the session working in that worktree, when it finishes its current turn or
  with your next message to it. Claude resolves each comment with a note or replies.
  Replying sends the thread back. *Copy as prompt* is there if you'd rather paste it yourself.
- **Merged worktrees clean themselves up.** Once a branch's PR merges, the worktree is
  removed, and its branch too if it matches the PR. This only happens if the worktree
  has no uncommitted changes, no live session is using it, its HEAD is in the merged PR
  and it has no unsent comments. Otherwise it tells you why it stayed. Only PRs merged
  after you install are cleaned up automatically. Older ones wait for *Remove N safe now*.
  Every removal has a restore command under *Cleaned up*.

## Install

You need Node 18+ on your `PATH`. For PR status and cleanup you also need the
[GitHub CLI](https://cli.github.com), logged in with `gh auth login`. Without it everything
else still works.

In Claude Code:

```
/plugin marketplace add llanicm/worktree-review
/plugin install worktree-review@worktree-review
```

Start a new session. The server starts in the background. Then run
`/worktree-review:open` or go to http://localhost:4747.

Update with `/plugin marketplace update worktree-review`, then `/plugin update worktree-review`.
The next session that starts replaces the running server with the new version.

## How it finds your worktrees

There's nothing to configure. It reads the working directories of your Claude Code sessions
from the last 30 days (`~/.claude/projects`), finds the git repo for each, and lists all of
that repo's worktrees. A live session counts as *working in* a worktree when its shell has
been inside it, or it has mentioned the path repeatedly.

## Settings

`~/.claude/worktree-review/config.json` is created on first run. Restart the server after
editing it: `curl -X POST -H 'x-wtr: 1' localhost:4747/api/shutdown`, then start a new
session or run `/worktree-review:open`.

| Key | Default | |
|---|---|---|
| `roots` | `[]` | Extra directories whose immediate children are scanned for repos |
| `extraRepos` | `[]` | Extra repo paths to always include |
| `autoCleanup` | `true` | Remove worktrees automatically when their PR merges (also a toggle in the sidebar) |
| `recentDays` | `3` | How long a worktree counts as *Recent* |
| `prPollMinutes` | `5` | How often PR status is checked |
| `editor` | `"vscode"` | Target of the *open* links: `vscode`, `cursor`, `windsurf`, `zed` or `none` |

Set `WTR_PORT` in your environment to use a different port.

## Where things live

- `~/.claude/worktree-review/state.json`: comments, review marks and the cleanup log
- `~/.claude/worktree-review/server.log`: server log
- The server only listens on `127.0.0.1`. Requests that change anything need an `x-wtr`
  header, which other websites can't send, and requests addressed to any host other
  than localhost are rejected.

## Optional: keep it running without Claude Code (macOS)

The plugin starts the server whenever a session starts. To keep it running from login
instead, clone this repo and run `extras/install-service.sh`. `extras/uninstall-service.sh`
removes it.

## Files

- `server/server.mjs`: the server. Node, no dependencies; it shells out to `git` and `gh`.
- `server/public/`: the page.
- `scripts/hook.mjs`: hands submitted reviews to the right session (`UserPromptSubmit` and `Stop` hooks).
- `scripts/ensure-server.mjs`: starts or upgrades the server (`SessionStart` hook and `/worktree-review:open`).
