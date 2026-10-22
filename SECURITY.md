# Security

Worktree Review runs a server on your machine that reads your git repositories and Claude Code
session files, and can remove worktrees. Security reports are taken seriously.

## Reporting a vulnerability

Please **don't open a public issue.** Report it privately through GitHub:
[Security → Report a vulnerability](https://github.com/llanicm/worktree-review/security/advisories/new).
Include what an attacker could do, and steps to reproduce if you can. You'll get a reply within a
week, and a fix is released before details are made public.

## Supported versions

Only the latest release is supported. Updating is `/plugin marketplace update worktree-review`
then `/plugin update worktree-review`.

## What's in scope

The server only listens on `127.0.0.1`, rejects requests addressed to any host other than
localhost (against DNS rebinding), and requires an `x-wtr` header on anything that changes state
(against cross-site requests). Ways around any of these, reading files outside the repos and
folders it's meant to see, or removing anything that could lose work, are all in scope.
