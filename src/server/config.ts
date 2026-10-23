import fs from 'node:fs';
import type { Config, Editor, ReviewEffort } from '../shared/api.ts';
import { CONFIG_PATH } from './paths.ts';
import { isRecord, isStringArray, loadJson } from './util.ts';

export const DEFAULT_CONFIG: Config = {
  // Repos are found automatically from where Claude Code sessions have worked.
  // Add directories here to also scan their immediate children for git repos.
  roots: [],
  // Extra repo paths to always include.
  extraRepos: [],
  // Remove a worktree automatically once its PR is merged (only when safe).
  autoCleanup: true,
  // Worktrees touched within this many days count as "recent".
  recentDays: 3,
  prPollMinutes: 5,
  // Editor for "open" links: vscode, cursor, windsurf, zed, or none.
  editor: 'vscode',
  // Effort preselected for Claude code reviews: low, medium, high, xhigh, or max.
  reviewEffort: 'low',
};

export const EDITORS: readonly string[] = ['vscode', 'cursor', 'windsurf', 'zed', 'none'];
export const isEditor = (v: unknown): v is Editor => typeof v === 'string' && EDITORS.includes(v);
export const EFFORTS: readonly ReviewEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
export const isEffort = (v: unknown): v is ReviewEffort => typeof v === 'string' && (EFFORTS as readonly string[]).includes(v);

// config.json is hand-editable, so each field is checked and falls back to its default.
function loadConfig(): Config {
  const saved = loadJson(CONFIG_PATH, {});
  const o = isRecord(saved) ? saved : {};
  const d = DEFAULT_CONFIG;
  return {
    roots: isStringArray(o.roots) ? o.roots : d.roots,
    extraRepos: isStringArray(o.extraRepos) ? o.extraRepos : d.extraRepos,
    autoCleanup: typeof o.autoCleanup === 'boolean' ? o.autoCleanup : d.autoCleanup,
    recentDays: typeof o.recentDays === 'number' ? o.recentDays : d.recentDays,
    prPollMinutes: typeof o.prPollMinutes === 'number' ? o.prPollMinutes : d.prPollMinutes,
    editor: isEditor(o.editor) ? o.editor : d.editor,
    reviewEffort: isEffort(o.reviewEffort) ? o.reviewEffort : d.reviewEffort,
  };
}

export const config: Config = loadConfig();
if (!fs.existsSync(CONFIG_PATH)) fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
