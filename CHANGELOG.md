# Changelog

## [2.6.0](https://github.com/llanicm/worktree-review/compare/v2.5.2...v2.6.0) (2026-11-20)


### Features

* add WebStorm as an editor for open links ([#36](https://github.com/llanicm/worktree-review/issues/36)) ([9710307](https://github.com/llanicm/worktree-review/commit/9710307065799d6b6138b5001e890bce63e26b0d))
* hide repos you don't review here ([#38](https://github.com/llanicm/worktree-review/issues/38)) ([d9b4c2c](https://github.com/llanicm/worktree-review/commit/d9b4c2ced0fa269a73e859a6824e90889777d923))
* make the dashboard installable as an app ([#42](https://github.com/llanicm/worktree-review/issues/42)) ([54546d2](https://github.com/llanicm/worktree-review/commit/54546d20d85cba0979d439d561f331ec31e7a316))
* offer to install the Claude Code plugin when the dashboard runs without it ([#37](https://github.com/llanicm/worktree-review/issues/37)) ([1a4fb9c](https://github.com/llanicm/worktree-review/commit/1a4fb9c46fcd286889b517cc0a2f4cf1d21a74c8))
* send the review with Cmd/Ctrl+Enter ([#40](https://github.com/llanicm/worktree-review/issues/40)) ([2cfe131](https://github.com/llanicm/worktree-review/commit/2cfe131cce35acf6ada3a3fa7be4de28b843d7f0))
* show newest commits first, as an option ([#41](https://github.com/llanicm/worktree-review/issues/41)) ([fbd928a](https://github.com/llanicm/worktree-review/commit/fbd928a99ec9f2beb1842d55ab7da7c296b095b0))

## [2.5.2](https://github.com/llanicm/worktree-review/compare/v2.5.1...v2.5.2) (2026-11-18)


### Bug fixes

* a session shows only in the worktree it is working in now ([#32](https://github.com/llanicm/worktree-review/issues/32)) ([b1735ac](https://github.com/llanicm/worktree-review/commit/b1735acbd576fb05598f4de245500e43b955cd31))
* the review bar can be minimised and stays minimised ([#34](https://github.com/llanicm/worktree-review/issues/34)) ([58ce429](https://github.com/llanicm/worktree-review/commit/58ce429b88f2c1b3eff2a75ebeaf9d1cbd5846c4))

## [2.5.1](https://github.com/llanicm/worktree-review/compare/v2.5.0...v2.5.1) (2026-11-18)


### Bug fixes

* ask before a CodeRabbit review runs on paid usage credits ([#30](https://github.com/llanicm/worktree-review/issues/30)) ([42eec99](https://github.com/llanicm/worktree-review/commit/42eec99916aa4187d615ea60c5af311938c46476))

## [2.5.0](https://github.com/llanicm/worktree-review/compare/v2.4.3...v2.5.0) (2026-11-18)


### Features

* show PR review comments in the diff and answer them from there ([#28](https://github.com/llanicm/worktree-review/issues/28)) ([98d386c](https://github.com/llanicm/worktree-review/commit/98d386cd28a33d623707a985cf696cdf8cd6924f))

## [2.4.3](https://github.com/llanicm/worktree-review/compare/v2.4.2...v2.4.3) (2026-11-02)


### Bug fixes

* keep the review panel's contents inside it when a session name is long ([#26](https://github.com/llanicm/worktree-review/issues/26)) ([9e7c4e8](https://github.com/llanicm/worktree-review/commit/9e7c4e8fb71aab48e0175820daa551287eb51dde))

## [2.4.2](https://github.com/llanicm/worktree-review/compare/v2.4.1...v2.4.2) (2026-11-02)


### Bug fixes

* review the whole branch with CodeRabbit, using its PR review policy ([#24](https://github.com/llanicm/worktree-review/issues/24)) ([5238fce](https://github.com/llanicm/worktree-review/commit/5238fcee9f88ed37d3ede1b017bfe9bb8cb79ac7))

## [2.4.1](https://github.com/llanicm/worktree-review/compare/v2.4.0...v2.4.1) (2026-10-25)


### Bug fixes

* give each reviewer one colour everywhere, and severity its own ([#20](https://github.com/llanicm/worktree-review/issues/20)) ([5ac03d5](https://github.com/llanicm/worktree-review/commit/5ac03d51a81d394b48bd3c9ba0f0fa582138e973))
* wake sessions that Claude Code marks as "shell" ([#21](https://github.com/llanicm/worktree-review/issues/21)) ([97e41a6](https://github.com/llanicm/worktree-review/commit/97e41a639540af39a72d3a1e74a54822a013342a))

## [2.4.0](https://github.com/llanicm/worktree-review/compare/v2.3.0...v2.4.0) (2026-10-23)


### Features

* list review findings as links and read them in the code ([#16](https://github.com/llanicm/worktree-review/issues/16)) ([7019d03](https://github.com/llanicm/worktree-review/commit/7019d03be98aaf4288c93e3b4e0cf3709f4f5580))


### Bug fixes

* link sessions only where they work, and show merged PRs on the main checkout ([#15](https://github.com/llanicm/worktree-review/issues/15)) ([86b886c](https://github.com/llanicm/worktree-review/commit/86b886c39e08cf813d85ab1e856387e4edcc2b54))
* start reviews instantly, and only flag them as out of date when the code changes ([#17](https://github.com/llanicm/worktree-review/issues/17)) ([6104c28](https://github.com/llanicm/worktree-review/commit/6104c28a81cf80df1bf3fc20cbb932fc4c87eed7))

## [2.3.0](https://github.com/llanicm/worktree-review/compare/v2.2.0...v2.3.0) (2026-10-23)


### Features

* wake an idle session when a review is sent to it ([#13](https://github.com/llanicm/worktree-review/issues/13)) ([87c59c9](https://github.com/llanicm/worktree-review/commit/87c59c9999c48da9c5e171c9f24fa6ff5b367bfd))

## [2.2.0](https://github.com/llanicm/worktree-review/compare/v2.1.0...v2.2.0) (2026-10-23)


### Features

* show subagents working in a worktree ([#11](https://github.com/llanicm/worktree-review/issues/11)) ([04834af](https://github.com/llanicm/worktree-review/commit/04834afee5e59ac6c6aec8e6d8654edcf815b130))

## [2.1.0](https://github.com/llanicm/worktree-review/compare/v2.0.5...v2.1.0) (2026-10-23)


### Features

* add Claude code review alongside CodeRabbit ([6e1ec0f](https://github.com/llanicm/worktree-review/commit/6e1ec0fd73779d8f5070e200ed00183aae3ad656))
