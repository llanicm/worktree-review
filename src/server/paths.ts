import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRecord } from './util.ts';

// The directory of the compiled server (dist/): static files are served from ./public and
// the plugin manifest sits at ../.claude-plugin/plugin.json.
export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const HOME = os.homedir();
export const PORT = Number(process.env.WTR_PORT || 4747);
export const CLAUDE_DIR = path.join(HOME, '.claude');
export const DATA_DIR = process.env.WTR_DATA_DIR || path.join(CLAUDE_DIR, 'worktree-review');
export const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
export const STATE_PATH = path.join(DATA_DIR, 'state.json');
export const TMP_DIR = path.join(DATA_DIR, 'tmp');
export const VERSION: string = (() => {
  try {
    const manifest: unknown = JSON.parse(fs.readFileSync(path.join(HERE, '..', '.claude-plugin', 'plugin.json'), 'utf8'));
    return isRecord(manifest) && typeof manifest.version === 'string' ? manifest.version : 'dev';
  } catch { return 'dev'; }
})();
fs.mkdirSync(TMP_DIR, { recursive: true });

export const expand = (p: string): string => (p.startsWith('~') ? path.join(HOME, p.slice(1)) : p);
