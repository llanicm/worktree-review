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
npm run watch       # rebuild as you edit (into .build/, which git ignores)
npm run demo        # try it on a made-up repo at http://localhost:4848
npm run check       # what CI runs: types, then a fresh build and the smoke test
```

The demo runs on its own made-up repo, home folder and stand-ins for `gh`, `coderabbit` and `claude`, so
it never touches your own repos or accounts.

### Things to know

- **Edit `src/`, and leave `dist/` out of your PR.** `dist/` is the build that plugin installs run
  (they have no build step), so it's committed, but CI rebuilds and commits it after every merge.
  The scripts above build into `.build/` instead, and a PR that changes `dist/` fails its check.
- **Strict TypeScript, no runtime dependencies.** The server uses Node built-ins and shells out to
  `git`, `gh`, `coderabbit` and `claude`; the page is plain DOM code. Request and response shapes live in
  `src/shared/api.ts`, used by both sides.
- **Keep it safe.** Anything that removes a worktree, deletes a branch or changes the user's repos
  needs a clear reason it can't lose work, and a test.
- **Add to the smoke test** (`test/smoke.test.ts`) for behaviour you add or fix. For anything that
  could make the page slower, compare `npm run bench` before and after.
- **Match the surrounding code:** its naming, terse style and comments that explain why, not what.
- **Don't bump the version.** release-please does that when a release is merged.

## Pull requests

- Keep each PR to one change, and describe what it does and why.
- CI must pass, and a maintainer reviews every PR before it's merged.
- PRs are squash-merged, so the PR title becomes the commit message. Write it as a
  [conventional commit](https://www.conventionalcommits.org) with a short, imperative summary:
  `feat: show blame for unchanged lines`, `fix(diff): keep comments on renamed files`. The type sets
  the next version: `fix` is a patch, `feat` a minor release, and `!` after the type (`feat!:`) a
  major one; `docs`, `refactor`, `test`, `build`, `ci` and `chore` don't release on their own. CI
  checks the title.

## Releasing (maintainers)

Releases are automated with [release-please](https://github.com/googleapis/release-please). After
each merge to `main`, it keeps a release PR open with the next version, worked out from the PR
titles, and the changelog. Merging that PR bumps the version in `package.json` and
`.claude-plugin/plugin.json`, tags `v<version>` and publishes a GitHub Release. Running dashboards
pick up the new version on the next session start, once users update the plugin.

The workflow needs a `RELEASE_PLEASE_TOKEN` secret: a fine-grained token with *Contents* and *Pull
requests* write access to this repository, so the release PR runs the required checks.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE)
and that you'll follow the [Code of Conduct](CODE_OF_CONDUCT.md).
