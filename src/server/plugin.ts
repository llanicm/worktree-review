import fs from 'node:fs';
import path from 'node:path';
import type { PluginInfo, PluginInstall } from '../shared/api.ts';
import { errInfo, run } from './exec.ts';
import { claudeBin, claudeEnv, lastJson } from './integrations.ts';
import { HERE } from './paths.ts';
import { changed, save, state } from './state.ts';
import { asStr, isRecord, log, rec } from './util.ts';

// ---------- the Claude Code plugin ----------
// Reviews reach sessions through the plugin's hooks, so a dashboard started by hand (npm start, the
// login service) works but can't deliver anything until the plugin is installed for the user.
// `claude plugin list` says so, asked at start, daily and after an install; a hook calling in
// stands in only when the CLI can't be asked.

const NAME = 'worktree-review';
const SEEN_FRESH = 7 * 864e5;
const CHECK_EVERY = 864e5;
const ROOT = path.dirname(HERE);
// Scopes whose hooks run in every session: installed for the user, or synced to the account by claude.ai.
const USER_WIDE = ['user', 'synced'];

let source = 'llanicm/worktree-review';
let install: PluginInstall | null = null;

const plugin = (): NonNullable<typeof state.plugin> => (state.plugin ??= {});

/** Called on every hook: some session has the plugin's hooks loaded. */
export function pluginSeen(): void {
  const p = plugin();
  const was = p.seenAt ?? 0;
  p.seenAt = Date.now();
  // Hooks run on every prompt; the file only needs to know roughly when.
  if (Date.now() - was > 3600_000) { save(); changed(); }
}

export function pluginInfo(): PluginInfo {
  const p = state.plugin ?? {};
  // The CLI's answer when there is one: a hook also runs for a project-only or since-removed install.
  const seen = !!p.seenAt && Date.now() - p.seenAt < SEEN_FRESH;
  const status = p.disabled ? 'disabled' : p.installed === true ? 'installed' : p.installed === false ? 'missing' : seen ? 'installed' : 'unknown';
  return { status, projectOnly: status === 'missing' && !!p.projectOnly, source, dismissed: !!p.dismissedAt, install };
}

// This copy's own repo, if it's a clone of one on GitHub (a fork installs the fork), else the published one.
async function findSource(): Promise<void> {
  try {
    const url = (await run('git', ['-C', ROOT, 'remote', 'get-url', 'origin'])).trim();
    const m = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
    if (m?.[1] && m[2]) { source = `${m[1]}/${m[2]}`; return; }
  } catch {}
  try {
    const repo = asStr(rec(JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'))).repository);
    const m = repo?.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (m?.[1] && m[2]) source = `${m[1]}/${m[2]}`;
  } catch {}
}

/** Asks the claude CLI whether the plugin is installed and enabled, unless a hook or a recent check already said. */
export async function checkPlugin(force = false): Promise<void> {
  await findSource();
  const p = plugin();
  if (!force && p.checkedAt && Date.now() - p.checkedAt < CHECK_EVERY) return;
  let out: string;
  try { out = await run(claudeBin(), ['plugin', 'list', '--json'], { env: claudeEnv(), timeout: 30_000 }); } catch { return; }
  let list: unknown;
  try { list = JSON.parse(out); } catch { list = lastJson(out); }
  if (!Array.isArray(list)) return;
  const mine = list.filter((e: unknown) => isRecord(e) && asStr(e.id)?.startsWith(`${NAME}@`)).map(rec);
  const userWide = mine.filter((e) => USER_WIDE.includes(asStr(e.scope) ?? ''));
  p.installed = userWide.some((e) => e.enabled !== false);
  p.disabled = !p.installed && userWide.length > 0;
  p.projectOnly = !userWide.length && mine.length > 0;
  p.checkedAt = Date.now();
  save();
  changed();
}

/** Installs the plugin for this user with the claude CLI. Its hooks load in sessions started after this. */
export function installPlugin(): PluginInstall {
  if (install?.running) return install;
  const started: PluginInstall = { running: true, error: null, finishedAt: null };
  install = started;
  changed();
  log(`installing the plugin from ${source}`);
  run(claudeBin(), ['plugin', 'install', NAME, '--marketplace', source, '--scope', 'user', '--json'], { env: claudeEnv(), timeout: 180_000 })
    .then(async () => {
      install = { running: false, error: null, finishedAt: Date.now() };
      await checkPlugin(true);
    }, (e: unknown) => {
      const { stdout, stderr, message } = errInfo(e);
      const result = rec(lastJson(stdout || ''));
      const msg = asStr(result.error) || asStr(result.message) || (stderr || '').trim().split('\n').pop() || message;
      install = { running: false, error: msg || 'The install did not finish.', finishedAt: Date.now() };
      log('plugin install failed', msg);
    })
    .finally(changed);
  return started;
}

export function dismissPlugin(): void {
  plugin().dismissedAt = Date.now();
  save();
  changed();
}
