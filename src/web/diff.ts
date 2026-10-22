// ---------- diff parsing ----------
import type { DiffFile, Hunk, RawFile } from './types.ts';
import { esc, fnv } from './util.ts';

function startHunk(line: string): Hunk {
  const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/) || [];
  return { header: line, oldNo: Number(m[1] || 0), newNo: Number(m[2] || 0), lines: [] };
}

export function parseDiff(text: string): DiffFile[] {
  const files: RawFile[] = [];
  let f: RawFile | null = null, h: Hunk | null = null;
  for (const l of text.split('\n')) {
    if (l.startsWith('diff --git ')) {
      const m = l.match(/^diff --git a\/(.*) b\/(.*)$/);
      f = { raw: [l], hunks: [], oldPath: m?.[1] ?? '', newPath: m?.[2] ?? '', status: 'modified', binary: false, add: 0, del: 0 };
      files.push(f);
      h = null;
      continue;
    }
    if (!f) continue;
    f.raw.push(l);
    if (!h) {
      if (l.startsWith('new file mode')) f.status = 'added';
      else if (l.startsWith('deleted file mode')) f.status = 'deleted';
      else if (l.startsWith('rename from ')) { f.oldPath = l.slice(12); f.status = 'renamed'; }
      else if (l.startsWith('rename to ')) f.newPath = l.slice(10);
      else if (l.startsWith('Binary files')) f.binary = true;
      else if (l.startsWith('--- ') && l !== '--- /dev/null') f.oldPath = l.slice(4).replace(/^a\//, '');
      else if (l.startsWith('+++ ') && l !== '+++ /dev/null') f.newPath = l.slice(4).replace(/^b\//, '');
      else if (l.startsWith('@@')) { h = startHunk(l); f.hunks.push(h); }
      continue;
    }
    if (l.startsWith('@@')) { h = startHunk(l); f.hunks.push(h); continue; }
    const c = l[0];
    if (c === '+') { h.lines.push({ t: 'add', text: l.slice(1), n: h.newNo++ }); f.add++; }
    else if (c === '-') { h.lines.push({ t: 'del', text: l.slice(1), o: h.oldNo++ }); f.del++; }
    else if (c === ' ') h.lines.push({ t: 'ctx', text: l.slice(1), o: h.oldNo++, n: h.newNo++ });
  }
  return files.map((file) => {
    const path = file.status === 'deleted' ? file.oldPath : file.newPath;
    return {
      ...file,
      path,
      hash: fnv(file.raw.join('\n')),
      lineCount: file.hunks.reduce((n, hk) => n + hk.lines.length, 0),
      generated: /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Cargo\.lock|go\.sum)$|__generated__|\.generated\.|\.snap$|\.min\.(js|css)$/.test(path),
    };
  });
}

const LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', sql: 'pgsql', py: 'python', go: 'go', rs: 'rust', rb: 'ruby', java: 'java', kt: 'kotlin', swift: 'swift',
  sh: 'bash', bash: 'bash', zsh: 'bash', yml: 'yaml', yaml: 'yaml', md: 'markdown', css: 'css', scss: 'scss', html: 'xml', xml: 'xml', svg: 'xml',
  graphql: 'graphql', gql: 'graphql', tf: 'ini', toml: 'ini', dockerfile: 'dockerfile', c: 'c', h: 'c', cpp: 'cpp', cs: 'csharp', php: 'php',
};
export function langFor(p: string): string | null {
  const base = (p.split('/').pop() ?? '').toLowerCase();
  if (base === 'dockerfile') return 'dockerfile';
  const lang = LANG[(base.split('.').pop() ?? '')];
  const lib = window.hljs;
  if (!lib || !lang) return null;
  if (lib.getLanguage(lang)) return lang;
  if (lang === 'pgsql' && lib.getLanguage('sql')) return 'sql';
  return null;
}
export function hl(text: string, lang: string | null) {
  const lib = window.hljs;
  if (!lang || !lib || text.length > 1000) return esc(text);
  try { return lib.highlight(text, { language: lang, ignoreIllegals: true }).value; } catch { return esc(text); }
}

// ---------- anchors (file|side|line, optionally prefixed by a commit) ----------

export const keyOf = (file: string, side: string, line: number | string | null | undefined, commit?: string | null) => `${commit ? `${commit}~` : ''}${file}|${side}|${line}`;
export function parseKey(k: string) {
  const m = k.match(/^([0-9a-f]{40})~(.*)$/);
  const rest = m ? (m[2] ?? '') : k;
  const i = rest.lastIndexOf('|'), j = rest.lastIndexOf('|', i - 1);
  return { commit: m ? (m[1] ?? null) : null, file: rest.slice(0, j), side: rest.slice(j + 1, i), line: Number(rest.slice(i + 1)) };
}
export const sameCommit = (a?: string | null, b?: string | null) => (a || null) === (b || null);
