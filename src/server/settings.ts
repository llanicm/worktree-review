import fs from 'node:fs';
import path from 'node:path';
import type { DirListing } from '../shared/api.ts';
import { config, isEditor } from './config.ts';
import { httpError } from './exec.ts';
import { CONFIG_PATH, expand, HOME } from './paths.ts';
import { changed } from './state.ts';
import { isRecord, isStringArray } from './util.ts';
import { discoverWorktrees } from './worktrees.ts';

const isIntIn = (v: unknown, min: number, max: number): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

export async function updateConfig(body: unknown): Promise<void> {
  const patch = isRecord(body) ? body : {};
  const errors: string[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'roots' || k === 'extraRepos') {
      if (!isStringArray(v)) { errors.push(`Invalid value for ${k}`); continue; }
      const missing = v.filter((p) => !fs.existsSync(expand(p.trim())));
      if (missing.length) { errors.push(`Folder not found: ${missing.join(', ')}`); continue; }
      config[k] = [...new Set(v.map((p) => p.trim()).filter(Boolean))];
    } else if (k === 'autoCleanup') {
      if (typeof v !== 'boolean') { errors.push(`Invalid value for ${k}`); continue; }
      config.autoCleanup = v;
    } else if (k === 'editor') {
      if (!isEditor(v)) { errors.push(`Invalid value for ${k}`); continue; }
      config.editor = v;
    } else if (k === 'recentDays') {
      if (!isIntIn(v, 1, 90)) { errors.push(`Invalid value for ${k}`); continue; }
      config.recentDays = v;
    } else if (k === 'prPollMinutes') {
      if (!isIntIn(v, 1, 60)) { errors.push(`Invalid value for ${k}`); continue; }
      config.prPollMinutes = v;
    }
  }
  if (errors.length) throw httpError(400, errors.join('; '));
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
  if ('roots' in patch || 'extraRepos' in patch) await discoverWorktrees();
  changed();
}

// Read-only folder listing for the folder picker, limited to the home directory.
const SKIP_DIRS = new Set(['node_modules', '.git', '.Trash', 'Library', '.cache', '.npm', '.pnpm-store']);
export function listDir(p: string | null, showHidden: boolean): DirListing {
  const full = path.resolve(expand(p || '~'));
  if (full !== HOME && !full.startsWith(HOME + path.sep)) throw httpError(403, 'Only folders inside your home directory can be browsed.');
  let dirents: fs.Dirent[];
  try { dirents = fs.readdirSync(full, { withFileTypes: true }); } catch { throw httpError(404, `Can't open ${full}`); }
  const isRepo = (d: string): boolean => fs.existsSync(path.join(d, '.git'));
  const entries: DirListing['entries'] = [];
  for (const e of dirents) {
    if (SKIP_DIRS.has(e.name) || (!showHidden && e.name.startsWith('.'))) continue;
    const child = path.join(full, e.name);
    let dir = e.isDirectory();
    if (!dir && e.isSymbolicLink()) { try { dir = fs.statSync(child).isDirectory(); } catch {} }
    if (!dir) continue;
    entries.push({ name: e.name, path: child, isRepo: isRepo(child) });
    if (entries.length >= 1000) break;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return {
    path: full,
    display: full === HOME ? '~' : full.startsWith(HOME + path.sep) ? '~' + full.slice(HOME.length) : full,
    parent: full === HOME ? null : path.dirname(full),
    isRepo: isRepo(full),
    repoChildren: entries.filter((e) => e.isRepo).length,
    entries,
  };
}
