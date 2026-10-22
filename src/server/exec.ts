import { execFile } from 'node:child_process';
import type { WorktreeError } from '../shared/api.ts';
import { firstLine } from './util.ts';

// ---------- errors ----------

/** An Error that carries the HTTP status to answer with. */
export interface HttpError extends Error { status: number }
export function httpError(status: number, message: string): HttpError {
  return Object.assign(new Error(message), { status });
}

const prop = (e: unknown, k: string): unknown => (typeof e === 'object' && e !== null ? (e as Record<string, unknown>)[k] : undefined);

export interface ErrInfo {
  message: string;
  /** "ENOENT", "EPERM", ... or a process exit code. */
  code: string | number | undefined;
  stdout: string;
  stderr: string;
  /** Set by httpError. */
  status: number | undefined;
}
/** What's known about a caught value: `catch (e)` is `unknown`, and failed commands carry stdout/stderr/code. */
export function errInfo(e: unknown): ErrInfo {
  const code = prop(e, 'code'), status = prop(e, 'status');
  return {
    message: String(prop(e, 'message') || e),
    code: typeof code === 'string' || typeof code === 'number' ? code : undefined,
    stdout: String(prop(e, 'stdout') || ''),
    stderr: String(prop(e, 'stderr') || ''),
    status: typeof status === 'number' ? status : undefined,
  };
}

// ---------- process helpers ----------

function pool(n: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: (() => void)[] = [];
  const next = (): void => {
    if (active >= n) return;
    const start = queue.shift();
    if (!start) return;
    active++;
    start();
  };
  return <T>(fn: () => Promise<T>) => new Promise<T>((resolve, reject) => {
    queue.push(() => { fn().then(resolve, reject).finally(() => { active--; next(); }); });
    next();
  });
}
const gitPool = pool(6);

export interface RunOpts { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number }

export function run(cmd: string, args: string[], opts: RunOpts = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', ...opts.env },
      maxBuffer: 256 * 1024 * 1024,
      timeout: opts.timeout ?? 60_000,
    }, (err, stdout, stderr) => {
      if (err) { err.message += `\n${stderr}`; reject(Object.assign(err, { stdout, stderr })); } else resolve(stdout);
    });
  });
}

// The useful part of a failed git command: its fatal:/error: line, not "Command failed: git ...".
export function gitError(e: unknown): string {
  const { stderr, message } = errInfo(e);
  const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean);
  const key = lines.find((l) => /^(fatal|error):/.test(l)) || lines[lines.length - 1];
  return (key || firstLine(message)).replace(/^(fatal|error):\s*/, '');
}

// Turn a git error about a worktree into something a person can act on.
export function explainWorktreeError(msg: string): WorktreeError {
  const m = msg.match(/not a git repository: (.+?)(?:\/\.git)?\/worktrees\//);
  if (m) {
    return {
      kind: 'broken-link',
      message: `This worktree's link to its repository is broken: it points to ${m[1]}, which isn't where the repository is now. This usually happens after the repository is moved. Repair runs \`git worktree repair\`, which rewrites the links for every worktree of this repository at once; no code in any worktree changes.`,
      detail: msg,
    };
  }
  if (/cannot be (moved or )?removed|containing submodules/.test(msg)) {
    return { kind: 'submodules', message: 'Git won\'t remove a worktree that contains submodules. Remove it by hand if you\'re sure.', detail: msg };
  }
  if (/contains modified or untracked files|is dirty/.test(msg)) {
    return { kind: 'dirty', message: 'Git found modified or untracked files in it, so it wasn\'t removed.', detail: msg };
  }
  if (/is locked|locked working tree/.test(msg)) {
    return { kind: 'locked', message: 'The worktree is locked. Something (often a Claude session) asked git to keep it.', detail: msg };
  }
  return { kind: 'other', message: msg, detail: msg };
}

export const git = (cwd: string, args: string[], opts?: RunOpts): Promise<string> =>
  gitPool(() => run('git', ['-c', 'core.quotepath=false', ...args], { ...opts, cwd }));
export const gitOk = (cwd: string, args: string[]): Promise<boolean> => git(cwd, args).then(() => true, () => false);

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return errInfo(e).code === 'EPERM'; }
}
