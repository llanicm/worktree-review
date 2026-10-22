// Formatting helpers, toasts, editor links.
import { need, S } from './state.ts';

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c] ?? c);

let toastTimer: number | undefined;
export function toast(msg: string, isErr = false) {
  const el = need('#toast');
  el.textContent = msg;
  el.className = 'toast' + (isErr ? ' err' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, isErr ? 6000 : 2500);
}

export function ago(ms?: number | null) {
  if (!ms) return '';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ms).toLocaleDateString();
}
export const elapsed = (ms: number) => { const s = Math.max(0, Math.floor((Date.now() - ms) / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
export const elapsedBetween = (a: number, b: number | null) => { const s = Math.max(0, Math.round(((b || Date.now()) - a) / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; };

export const tilde = (p: string) => (S.st?.home && p.startsWith(S.st.home) ? '~' + p.slice(S.st.home.length) : p);
export const expandHome = (p: string) => (p.startsWith('~') && S.st?.home ? S.st.home + p.slice(1) : p);
const EDITORS: Record<string, string> = { vscode: 'vscode', cursor: 'cursor', windsurf: 'windsurf', zed: 'zed' };
const EDITOR_NAMES: Record<string, string> = { vscode: 'VS Code', cursor: 'Cursor', windsurf: 'Windsurf', zed: 'Zed' };
export const editorName = () => EDITOR_NAMES[S.st?.config.editor ?? ''] || null;
export function editorLink(p: string, line?: number) {
  const scheme = EDITORS[S.st?.config.editor ?? ''];
  if (!scheme) return null;
  return scheme === 'zed' ? `zed://file${p}${line ? `:${line}` : ''}` : `${scheme}://file${p}${line ? `:${line}` : ''}`;
}
export const shortPath = (p: string) => { const parts = tilde(p).split('/'); return parts.length > 3 ? '…/' + parts.slice(-2).join('/') : tilde(p); };
export const fnv = (s: string) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };
export const copy = (text: string, label = 'Copied') => navigator.clipboard.writeText(text).then(() => toast(label), () => toast('Copy failed', true));

export function md(text: string) {
  return esc(text)
    .replace(/```([\s\S]*?)```/g, (_, c: string) => `<code>${c.trim()}</code>`)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
}
