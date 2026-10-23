import { spawn } from 'node:child_process';
import type { CodeRabbitLogin, Integrations } from '../shared/api.ts';
import { errInfo, run, type RunOpts } from './exec.ts';
import { CONFIG_PATH, DATA_DIR, VERSION } from './paths.ts';
import { changed, sessions } from './state.ts';
import { asStr, rec } from './util.ts';

// ---------- integrations (gh, CodeRabbit, Claude) ----------

let lastHookAt: number | null = null;
export function markHook(): void { lastHookAt = Date.now(); }

let integrations: { at: number; data: Integrations | null; pending: Promise<Integrations> | null } = { at: 0, data: null, pending: null };
export let crLogin: CodeRabbitLogin | null = null;

/** Whether CodeRabbit is installed and signed in, as of the last check. */
export const coderabbitReady = (): boolean => !!(integrations.data?.coderabbit.installed && integrations.data?.coderabbit.authed);
/** Whether the claude CLI was found, as of the last check. */
export const claudeReady = (): boolean => !!integrations.data?.claude.cliVersion;

// `claude` on the PATH, or else the binary of the session whose hook started this server.
let claudePath = 'claude';
export const claudeBin = (): string => claudePath;

async function probeClaude(): Promise<Probe> {
  const onPath = await probe('claude', ['--version']);
  const exec = process.env.CLAUDE_CODE_EXECPATH;
  if (!onPath.missing || !exec) { claudePath = 'claude'; return onPath; }
  claudePath = exec;
  return probe(exec, ['--version']);
}

export interface Probe { ok: boolean; missing?: boolean; out: string }

export async function probe(cmd: string, args: string[], opts: RunOpts = {}): Promise<Probe> {
  try {
    return { ok: true, out: await run(cmd, args, { timeout: 15_000, ...opts }) };
  } catch (e) {
    const { code, stdout, stderr } = errInfo(e);
    return { ok: false, missing: code === 'ENOENT', out: `${stdout}${stderr}` };
  }
}

/** The last line of `text` that parses as JSON (the CLIs print progress lines before it). */
export function lastJson(text: string): unknown {
  const lines = text.trim().split('\n').reverse();
  for (const l of lines) { try { return JSON.parse(l); } catch {} }
  return null;
}

async function checkIntegrations(): Promise<Integrations> {
  const [ghV, ghAuth, crV, crStatus, crPlain, claudeV] = await Promise.all([
    probe('gh', ['--version']),
    probe('gh', ['auth', 'status', '--hostname', 'github.com']),
    probe('coderabbit', ['--version']),
    probe('coderabbit', ['auth', 'status', '--agent']),
    probe('coderabbit', ['auth', 'status']),
    probeClaude(),
  ]);
  const gh: Integrations['gh'] = { installed: !ghV.missing, version: ghV.out.match(/gh version (\S+)/)?.[1] || null, authed: ghAuth.ok, account: null };
  gh.account = ghAuth.out.match(/account (\S+)/)?.[1] || null;
  const st = rec(lastJson(crStatus.out));
  const cr: Integrations['coderabbit'] = { installed: !crV.missing, version: crV.ok ? crV.out.trim().split('\n')[0] ?? null : null, authed: !!st.authenticated };
  if (st.authenticated) {
    const user = rec(st.user);
    cr.user = asStr(user.username) || asStr(user.name);
    cr.email = asStr(user.email);
    cr.org = asStr(rec(st.currentOrg).name) || null;
    cr.orgs = (Array.isArray(st.organizations) ? st.organizations : []).map((o: unknown) => asStr(rec(o).name)).filter((n): n is string => n !== undefined);
    cr.plan = crPlain.out.match(/Plan\s*:\s*(.+)/)?.[1]?.trim() || null;
    cr.seat = crPlain.out.match(/Seat\s*:\s*(.+)/)?.[1]?.trim() || null;
  }
  return {
    gh, coderabbit: cr, coderabbitLogin: crLogin,
    claude: { lastHookAt, sessions: sessions.size, version: VERSION, cliVersion: claudeV.ok ? claudeV.out.trim().split(/\s/)[0] || null : null },
    node: process.version, dataDir: DATA_DIR, configPath: CONFIG_PATH,
  };
}

export async function getIntegrations(force = false): Promise<Integrations> {
  if (!force && integrations.data && Date.now() - integrations.at < 60_000) {
    return { ...integrations.data, coderabbitLogin: crLogin, claude: { ...integrations.data.claude, lastHookAt, sessions: sessions.size } };
  }
  const pending = integrations.pending ?? checkIntegrations().then((data) => {
    integrations = { at: Date.now(), data, pending: null };
    return data;
  }, (e: unknown) => { integrations.pending = null; throw e; });
  integrations.pending = pending;
  return pending;
}

export function startCodeRabbitLogin(): CodeRabbitLogin {
  if (crLogin?.running) return crLogin;
  const init: CodeRabbitLogin = { running: true, url: null, error: null, startedAt: Date.now() };
  crLogin = init;
  const child = spawn('coderabbit', ['auth', 'login', '--agent'], { env: process.env });
  let out = '';
  const onData = (d: Buffer): void => {
    out += d;
    const url = out.match(/https:\/\/app\.coderabbit\.ai\/login[^\s"'\]]*/)?.[0];
    if (url && crLogin && !crLogin.url) { crLogin.url = url.replace(/&amp;/g, '&'); changed(); }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  const timer = setTimeout(() => child.kill(), 5 * 60_000);
  child.on('error', (e) => { crLogin = { ...(crLogin ?? init), running: false, error: errInfo(e).code === 'ENOENT' ? 'CodeRabbit CLI is not installed.' : e.message }; changed(); });
  child.on('close', async (code) => {
    clearTimeout(timer);
    const result = rec(lastJson(out));
    crLogin = { ...(crLogin ?? init), running: false, error: code === 0 ? null : (asStr(result.message) || asStr(result.error) || 'Login did not finish.') };
    await getIntegrations(true).catch(() => {});
    changed();
  });
  changed();
  return init;
}
