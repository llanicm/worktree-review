# Contributing

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Before you start

- **Bugs:** open an issue with the bug report form. Say what you did, what happened, and your OS,
  Node and git versions. The server log (`~/.claude/worktree-review/server.log`) usually helps.
- **Features or larger changes:** open an issue first, so we can agree on the approach before you
  spend time on it.
- **Security problems:** don't open an issue. See [SECURITY.md](SECURITY.md).

## Making a change

All changes go through a pull request to `main`; nobody pushes to it directly. Fork the repo,
make a branch, and open a PR when it's ready.

You need Node 22.18+ to develop (it runs the TypeScript tests directly), git, and Google Chrome
for the page tests.

```sh
npm install
npm run watch       # rebuild dist/ as you edit
npm run demo        # try it on a made-up repo at http://localhost:4848
npm run check       # what CI runs: types, dist/ matching src/, and the smoke test
```

The demo runs on its own made-up repo, home folder and stand-ins for `gh` and `coderabbit`, so
it never touches your own repos or accounts.

### Things to know

- **Edit `src/`, never `dist/` by hand.** `dist/` is committed, because a Claude Code plugin is
  installed straight from the repo with no build step. Run `npm run build` and commit the result
  with your change; CI fails if `dist/` doesn't match `src/`.
- **Strict TypeScript, no runtime dependencies.** The server uses Node built-ins and shells out to
  `git`, `gh` and `coderabbit`; the page is plain DOM code. Request and response shapes live in
  `src/shared/api.ts`, used by both sides.
- **Keep it safe.** Anything that removes a worktree, deletes a branch or changes the user's repos
  needs a clear reason it can't lose work, and a test.
- **Add to the smoke test** (`test/smoke.test.ts`) for behaviour you add or fix. For anything that
  could make the page slower, compare `npm run bench` before and after.
- **Match the surrounding code:** its naming, terse style and comments that explain why, not what.
- **Don't bump the version.** The maintainer does that when releasing.

## Pull requests

- Keep each PR to one change, and describe what it does and why.
- CI must pass, and a maintainer reviews every PR before it's merged.
- PRs are squash-merged, so the PR title becomes the commit message: write it as a short,
  imperative summary ("Show blame for unchanged lines").

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE)
and that you'll follow the [Code of Conduct](CODE_OF_CONDUCT.md).
