// Worktree Review — client. Plain JS, rendered from state; the server pushes updates over SSE.
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', 'x-wtr': '1' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json;
}

let toastTimer;
function toast(msg, isErr = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (isErr ? ' err' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, isErr ? 6000 : 2500);
}

function ago(ms) {
  if (!ms) return '';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ms).toLocaleDateString();
}
const tilde = (p) => (S.st?.home && p.startsWith(S.st.home) ? '~' + p.slice(S.st.home.length) : p);
const EDITORS = { vscode: 'vscode', cursor: 'cursor', windsurf: 'windsurf', zed: 'zed' };
const editorName = () => ({ vscode: 'VS Code', cursor: 'Cursor', windsurf: 'Windsurf', zed: 'Zed' }[S.st?.config.editor] || null);
function editorLink(p, line) {
  const scheme = EDITORS[S.st?.config.editor];
  if (!scheme) return null;
  return scheme === 'zed' ? `zed://file${p}${line ? `:${line}` : ''}` : `${scheme}://file${p}${line ? `:${line}` : ''}`;
}
const shortPath = (p) => { const parts = tilde(p).split('/'); return parts.length > 3 ? '…/' + parts.slice(-2).join('/') : tilde(p); };
const fnv = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };
const copy = (text, label = 'Copied') => navigator.clipboard.writeText(text).then(() => toast(label), () => toast('Copy failed', true));

function md(text) {
  return esc(text)
    .replace(/```([\s\S]*?)```/g, (_, c) => `<code>${c.trim()}</code>`)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
}

// ---------- state ----------

const S = {
  st: null,          // server state
  selId: null,
  mode: null,        // 'full' | 'since'
  view: null,        // { wtId, diff, files, comments, reviews }
  seq: 0,
  editors: new Map(), // editor key -> text
  focusEk: null,
  toggled: new Map(), // file path -> collapsed?
  forceRender: new Set(),
  filter: '',
  showOlder: false,
  showCleaned: false,
  stale: false,
  summaries: {},     // wtId -> review summary draft
  prevStatus: new Map(),
  page: null,        // 'settings' | 'welcome' | 'cleanup' | null
  cleanSel: new Map(), // clean-up page: worktree id -> ticked
  shutCommits: new Set(), // collapsed commit sections in By commit view
  openBodies: new Set(),  // commit messages expanded past the clamp
  removeErrors: {},       // wtId -> why the last removal failed
  seenJobs: new Set(),    // finished jobs already handled
  integ: null,       // integrations status from the server
  setupSig: null,
};

// ---------- sidebar ----------

function grouped(list) {
  const recentMs = S.st.config.recentDays * 864e5;
  const g = { working: [], merged: [], recent: [], older: [] };
  for (const wt of list) {
    if (wt.sessions.length) g.working.push(wt);
    else if (wt.pr?.state === 'MERGED') g.merged.push(wt);
    else if (Date.now() - wt.lastActivity < recentMs) g.recent.push(wt);
    else g.older.push(wt);
  }
  for (const k of Object.keys(g)) g[k].sort((a, b) => b.lastActivity - a.lastActivity);
  return g;
}

function prChip(pr) {
  if (!pr) return '';
  const cls = pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : pr.isDraft ? 'draftpr' : 'open';
  const label = pr.state === 'OPEN' && pr.isDraft ? 'draft' : pr.state.toLowerCase();
  return `<span class="chip ${cls}" title="${esc(pr.title)}">#${pr.number} ${label}</span>`;
}

function sessionChip(s) {
  return `<span class="chip" title="Claude session ${esc(s.name)} is ${esc(s.status)}"><span class="dot ${esc(s.status)}"></span>${esc(s.name)}</span>`;
}

function wtItem(wt, showNew) {
  const name = wt.branch || `detached @ ${wt.head?.slice(0, 8) || '?'}`;
  const c = wt.comments;
  const nComments = c.draft + c.waiting + c.open;
  const stats = wt.stats && (wt.stats.add || wt.stats.del)
    ? `<span class="stat-add">+${wt.stats.add}</span><span class="stat-del">−${wt.stats.del}</span>` : '';
  return `<a class="wt ${S.selId === wt.id ? 'sel' : ''}" href="#/${wt.id}" title="${esc(wt.path)}">
    <div class="wt-top">
      ${showNew && wt.review.needsReview ? '<span class="new-dot" title="Changed since you last reviewed"></span>' : ''}
      <span class="wt-branch">${esc(name)}</span>${stats}
    </div>
    <div class="wt-sub">
      <span class="wt-path">${esc(shortPath(wt.path))}</span><span>· ${ago(wt.lastActivity)}</span>
    </div>
    <div class="wt-sub">
      ${wt.sessions.map(sessionChip).join('')}${prChip(wt.pr)}
      ${nComments ? `<span class="chip comments">${nComments} comment${nComments === 1 ? '' : 's'}</span>` : ''}
      ${wt.busy ? '<span class="chip busy-chip"><span class="dot busy"></span>removing…</span>' : ''}
      ${wt.error ? `<span class="chip closed" title="${esc(wt.error.message)}">${wt.error.kind === 'broken-link' ? 'broken link' : "can't read"}</span>`
        : wt.dirtyKind === 'lockfile-only' ? '<span class="chip" title="Only a lockfile changed">lockfile changed</span>'
        : wt.dirtyKind === 'deleted-only' ? `<span class="chip" title="Tracked files missing from disk; nothing is lost">${wt.dirty} missing</span>`
        : wt.dirty ? `<span class="chip" title="Uncommitted changes">${wt.dirty} uncommitted</span>` : ''}
      ${wt.coderabbit?.status === 'running' ? '<span class="chip cr"><span class="dot busy"></span>CodeRabbit</span>'
        : wt.coderabbit?.open ? `<span class="chip cr">${wt.coderabbit.open} finding${wt.coderabbit.open === 1 ? '' : 's'}</span>` : ''}
    </div>
  </a>`;
}

function renderSidebar() {
  if (!S.st) return;
  const f = S.filter.toLowerCase();
  const list = S.st.worktrees.filter((w) => !f || (w.branch || '').toLowerCase().includes(f) || w.path.toLowerCase().includes(f));
  const g = grouped(list);
  const safe = g.merged.filter((w) => w.cleanup?.kind === 'merged' && w.cleanup.eligible).length;
  const idle = S.st.worktrees.filter((w) => w.cleanup && !w.sessions.length).length;
  const parts = [];
  const section = (title, items, opts = {}) => {
    if (!items.length && !opts.always) return;
    parts.push(`<div class="group-head"><span>${title} <span class="count">${items.length}</span></span>${opts.right || ''}</div>`);
    if (opts.tools) parts.push(opts.tools);
    if (!opts.hidden) parts.push(items.map((w) => wtItem(w, opts.showNew)).join(''));
  };
  const broken = S.st.worktrees.filter((w) => w.error?.kind === 'broken-link').length;
  if (broken) {
    parts.push(`<div class="side-alert"><strong>${broken} worktree${broken === 1 ? ' has a' : 's have'} broken link${broken === 1 ? '' : 's'}</strong>
      to ${broken === 1 ? 'its' : 'their'} repository, so git can't read ${broken === 1 ? 'it' : 'them'}. This usually means the repository moved.
      <button class="btn small" data-act="repair-all">Repair ${broken === 1 ? 'it' : `all ${broken}`}</button></div>`);
  }
  section('Claude is working', g.working, { showNew: true });
  section('Recent', g.recent, { showNew: true });
  section('PR merged', g.merged, {
    tools: `<div class="group-tools">
      <label class="toggle"><input type="checkbox" data-act="auto-cleanup" ${S.st.config.autoCleanup ? 'checked' : ''}> Remove automatically when merged</label>
      ${safe ? `<button class="link-btn" data-act="cleanup-safe">Remove ${safe} safe now</button>` : ''}
    </div>`,
  });
  section('Older', g.older, {
    hidden: !S.showOlder && !f,
    right: f ? '' : `<button class="link-btn" data-act="toggle-older">${S.showOlder ? 'hide' : 'show'}</button>`,
  });
  if (idle && !f) {
    parts.push(`<div class="group-tools"><a class="link-btn" href="#/cleanup">Clean up worktrees no session is using (${idle})</a></div>`);
  }
  if (S.st.cleaned.length) {
    parts.push(`<div class="group-head"><span>Cleaned up <span class="count">${S.st.cleaned.length}</span></span>
      <button class="link-btn" data-act="toggle-cleaned">${S.showCleaned ? 'hide' : 'show'}</button></div>`);
    if (S.showCleaned) {
      parts.push(`<div class="cleaned">${S.st.cleaned.map((c, i) => `<div class="item">
        <div><strong>${esc(c.branch || `detached @ ${c.sha.slice(0, 8)}`)}</strong>${c.pr ? ` · <a href="${esc(c.pr.url)}" target="_blank">#${c.pr.number}</a>` : ''} · ${c.how === 'auto' ? 'auto' : c.how === 'forced' ? 'removed anyway' : 'by you'} ${ago(c.at)}${c.reason === 'idle' ? ' · unmerged' : ''}</div>
        ${c.branchKept ? `<div>Branch ${esc(c.branchKept)}</div>` : ''}
        <div class="mono">${esc(shortPath(c.path))}</div>
        <button class="link-btn" data-act="copy-restore" data-i="${i}">Copy restore command</button>
      </div>`).join('')}</div>`);
    }
  }
  if (!S.st.worktrees.length) parts.push('<div class="group-tools">No worktrees yet. Repos show up here once Claude Code has worked in them.</div>');
  if (S.st.prError) parts.unshift(`<div class="group-tools">${md(S.st.prError)}</div>`);
  $('#list').innerHTML = parts.join('');
  renderJobs();

  const n = S.st.worktrees.filter((w) => w.review.needsReview && (w.sessions.length || Date.now() - w.lastActivity < S.st.config.recentDays * 864e5)).length;
  document.title = n ? `(${n}) Worktree Review` : 'Worktree Review';
}

// ---------- diff parsing ----------

function startHunk(line) {
  const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/) || [];
  return { header: line, oldNo: Number(m[1] || 0), newNo: Number(m[2] || 0), lines: [] };
}

function parseDiff(text) {
  const files = [];
  let f = null, h = null;
  for (const l of text.split('\n')) {
    if (l.startsWith('diff --git ')) {
      const m = l.match(/^diff --git a\/(.*) b\/(.*)$/);
      f = { raw: [l], hunks: [], oldPath: m?.[1], newPath: m?.[2], status: 'modified', binary: false, add: 0, del: 0 };
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
  for (const file of files) {
    file.path = file.status === 'deleted' ? file.oldPath : file.newPath;
    file.hash = fnv(file.raw.join('\n'));
    file.lineCount = file.hunks.reduce((n, hk) => n + hk.lines.length, 0);
    file.generated = /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Cargo\.lock|go\.sum)$|__generated__|\.generated\.|\.snap$|\.min\.(js|css)$/.test(file.path);
  }
  return files;
}

const LANG = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', sql: 'pgsql', py: 'python', go: 'go', rs: 'rust', rb: 'ruby', java: 'java', kt: 'kotlin', swift: 'swift',
  sh: 'bash', bash: 'bash', zsh: 'bash', yml: 'yaml', yaml: 'yaml', md: 'markdown', css: 'css', scss: 'scss', html: 'xml', xml: 'xml', svg: 'xml',
  graphql: 'graphql', gql: 'graphql', tf: 'ini', toml: 'ini', dockerfile: 'dockerfile', c: 'c', h: 'c', cpp: 'cpp', cs: 'csharp', php: 'php',
};
function langFor(p) {
  const base = p.split('/').pop().toLowerCase();
  if (base === 'dockerfile') return 'dockerfile';
  const lang = LANG[base.split('.').pop()];
  const hl = window.hljs;
  if (!hl || !lang) return null;
  if (hl.getLanguage(lang)) return lang;
  if (lang === 'pgsql' && hl.getLanguage('sql')) return 'sql';
  return null;
}
function hl(text, lang) {
  if (!lang || text.length > 1000) return esc(text);
  try { return window.hljs.highlight(text, { language: lang, ignoreIllegals: true }).value; } catch { return esc(text); }
}

// ---------- main view ----------

const curWt = () => S.st?.worktrees.find((w) => w.id === S.selId);
const keyOf = (file, side, line, commit) => `${commit ? `${commit}~` : ''}${file}|${side}|${line}`;
function parseKey(k) {
  const m = k.match(/^([0-9a-f]{40})~(.*)$/);
  const rest = m ? m[2] : k;
  const i = rest.lastIndexOf('|'), j = rest.lastIndexOf('|', i - 1);
  return { commit: m ? m[1] : null, file: rest.slice(0, j), side: rest.slice(j + 1, i), line: Number(rest.slice(i + 1)) };
}
const sameCommit = (a, b) => (a || null) === (b || null);
const commitClass = (n) => (n === 0 ? 'cu' : `c${((n - 1) % 8) + 1}`);
const commitLabel = (n) => (n === 0 ? 'uncommitted' : `#${n}`);

// Commit number (0 = uncommitted) that last touched line n of a file, from blame runs.
function commitOfLine(file, n) {
  const b = S.view?.blame?.lines?.[file];
  if (!b) return undefined;
  for (const [a, z, c] of b) if (n >= a && n <= z) return c;
  return undefined;
}
function commitByN(n) { return S.view?.diff.commits.find((c) => c.n === n); }

function isCollapsed(f) {
  if (S.toggled.has(f.uid)) return S.toggled.get(f.uid);
  return (!f.commit && S.view.diff.viewed[f.path] === f.hash) || f.generated;
}

function statusLabel(c) {
  if (c.status === 'draft') return 'Draft';
  if (c.status === 'pending') return 'Submitted · waiting for a session';
  if (c.status === 'delivered') return `Sent to ${c.deliveredTo?.name || 'Claude'}`;
  if (c.status === 'resolved') return 'Resolved';
  return c.status;
}

function editorHtml(ek, label) {
  return `<div class="editor"><textarea data-ek="${esc(ek)}" placeholder="Leave a comment">${esc(S.editors.get(ek) || '')}</textarea>
    <div class="actions"><span class="hint">⌘↵ to save · Esc to cancel</span>
      <button class="btn small" data-act="cancel-editor" data-ek="${esc(ek)}">Cancel</button>
      <button class="btn small primary" data-act="save-editor" data-ek="${esc(ek)}">${label}</button></div></div>`;
}

function threadHtml(c) {
  const editing = S.editors.has(`edit:${c.id}`);
  const replying = S.editors.has(`reply:${c.id}`);
  const msgs = [`<div class="msg"><div class="msg-head"><strong>You</strong><span class="status ${c.status}">${esc(statusLabel(c))}</span><span>${ago(c.createdAt)}</span></div>
    ${editing ? editorHtml(`edit:${c.id}`, 'Update') : `<div class="msg-body">${md(c.body)}</div>`}</div>`];
  for (const r of c.replies || []) {
    msgs.push(`<div class="msg"><div class="msg-head"><strong>${r.author === 'you' ? 'You' : 'Claude'}</strong><span>${ago(r.at)}</span></div><div class="msg-body">${md(r.body)}</div></div>`);
  }
  const acts = [];
  if (c.status === 'draft' && !editing) acts.push(`<button class="btn small" data-act="edit" data-id="${c.id}">Edit</button>`, `<button class="btn small danger" data-act="delete" data-id="${c.id}">Delete</button>`);
  if (c.status === 'delivered' || c.status === 'pending') acts.push(`<button class="btn small" data-act="resolve" data-id="${c.id}">Resolve</button>`);
  if (c.status === 'resolved') acts.push(`<button class="btn small" data-act="reopen" data-id="${c.id}">Reopen</button>`);
  if (c.status !== 'draft' && !replying) acts.push(`<button class="btn small" data-act="reply" data-id="${c.id}">Reply</button>`);
  if (replying) msgs.push(`<div class="msg">${editorHtml(`reply:${c.id}`, 'Reply')}<div class="msg-head">A reply turns this back into a draft to send to Claude with your next review.</div></div>`);
  return `<div class="thread ${c.status}">${msgs.join('')}${acts.length ? `<div class="thread-actions">${acts.join('')}</div>` : ''}</div>`;
}

function renderFile(f, byAnchor, used) {
  const collapsed = isCollapsed(f);
  const viewed = S.view.diff.viewed[f.path] === f.hash;
  const wt = curWt();
  const name = f.status === 'renamed' && f.oldPath !== f.newPath
    ? `<span class="from">${esc(f.oldPath)} →</span> ${esc(f.newPath)}` : esc(f.path);
  const tag = f.status !== 'modified' ? `<span class="file-tag">${f.status}</span>` : '';
  const gen = f.generated ? '<span class="file-tag">generated</span>' : '';
  const firstLine = f.hunks[0]?.lines.find((l) => l.n)?.n || 1;

  let body;
  const lang = langFor(f.path);
  // Lines this diff actually shows; anything anchored elsewhere goes in the "not on a changed line" block.
  const shown = new Set();
  for (const h of f.hunks) for (const l of h.lines) shown.add(l.t === 'del' ? keyOf(f.path, 'old', l.o, f.commit) : keyOf(f.path, 'new', l.n, f.commit));
  const mine = (S.view.comments || []).filter((c) => c.file === f.path && sameCommit(c.commit, f.commit) && c.status !== 'resolved');
  const outsideComments = mine.filter((c) => !shown.has(keyOf(c.file, c.side, c.line, c.commit)));
  const fileFindings = f.commit ? [] : (S.view.cr?.findings || []).filter((x) => x.file === f.path && x.status === 'open');
  const outsideFindings = fileFindings.filter((x) => !shown.has(keyOf(x.file, 'new', x.endLine || x.startLine)));
  const nOpen = mine.length + fileFindings.length;
  const touched = !f.commit ? (S.view.diff.fileCommits?.[f.path] || []) : [];
  const commitChips = touched.length && S.view.diff.commits.length
    ? touched.map((n) => `<span class="cchip ${commitClass(n)}" title="${esc(n ? `${commitByN(n)?.sha.slice(0, 8)} ${commitByN(n)?.subject || ''}` : 'Not committed yet')}">${commitLabel(n)}</span>`).join('') : '';
  const head = `<div class="file-head">
    <button class="caret" data-act="toggle-file" data-file="${esc(f.uid)}" aria-label="Collapse">${collapsed ? '▸' : '▾'}</button>
    ${f.commitN !== undefined && f.commit !== null || f.uncommitted ? `<span class="cchip fill ${commitClass(f.commitN)}" title="${esc(f.uncommitted ? 'Uncommitted changes' : `Commit #${f.commitN}`)}">${f.uncommitted ? '±' : `#${f.commitN}`}</span>` : ''}
    <span class="file-name" title="${esc(f.path)}">${name}</span>${tag}${gen}${commitChips}
    <span class="stat-add">+${f.add}</span><span class="stat-del">−${f.del}</span>
    ${collapsed && nOpen ? `<span class="chip comments" title="Expand to see them">${nOpen} comment${nOpen === 1 ? '' : 's'}</span>` : ''}
    ${f.status !== 'deleted' && wt && editorLink(wt.path) ? `<a class="file-tag" href="${esc(editorLink(`${wt.path}/${f.path}`, firstLine))}" title="Open in ${editorName()}">open</a>` : ''}
    ${f.commit ? '' : `<label class="viewed-box ${viewed ? 'on' : ''}"><input type="checkbox" data-act="viewed" data-file="${esc(f.path)}" ${viewed ? 'checked' : ''}> Viewed</label>`}
  </div>`;
  if (collapsed) body = '';
  else if (f.binary) body = '<div class="file-note">Binary file</div>';
  else if (!f.hunks.length) body = `<div class="file-note">${f.status === 'renamed' ? 'Renamed without changes' : 'No content changes (mode change or empty file)'}</div>`;
  else if (f.lineCount > 2500 && !S.forceRender.has(f.uid)) body = `<div class="file-note">Large diff (${f.lineCount} lines). <button class="link-btn" data-act="force-render" data-file="${esc(f.uid)}">Load it</button></div>`;
  else {
    const rows = [];
    for (const h of f.hunks) {
      rows.push(`<tr class="hunk"><td colspan="3">${esc(h.header)}</td></tr>`);
      for (const l of h.lines) {
        const side = l.t === 'del' ? 'old' : 'new';
        const line = l.t === 'del' ? l.o : l.n;
        const k = keyOf(f.path, side, line, f.commit);
        const sign = l.t === 'add' ? '+' : l.t === 'del' ? '−' : ' ';
        const cn = !f.commit && l.t === 'add' ? commitOfLine(f.path, l.n) : undefined;
        const cAttr = cn !== undefined ? ` data-c="${cn}"` : '';
        const cBar = cn !== undefined ? `<span class="cbar ${commitClass(cn)}" title="${esc(cn ? `#${cn} ${commitByN(cn)?.sha.slice(0, 8)} ${commitByN(cn)?.subject || ''}` : 'Not committed yet')}"></span>` : '';
        rows.push(`<tr class="line ${l.t}" data-k="${esc(k)}"${cAttr}><td class="num" data-act="new-comment" data-k="${esc(k)}">${l.o ?? ''}</td><td class="num" data-act="new-comment" data-k="${esc(k)}">${l.n ?? ''}</td><td class="code">${cBar}<button class="add-c" data-act="new-comment" data-k="${esc(k)}" title="Comment on this line">+</button><span class="sign">${sign}</span>${hl(l.text, lang)}</td></tr>`);
        const crHere = side === 'new' ? (S.view.crByAnchor?.get(k) || []) : [];
        const threads = (byAnchor.get(k) || []);
        threads.forEach((c) => used.add(c.id));
        const ek = `new:${k}`;
        if (threads.length || crHere.length || S.editors.has(ek)) {
          rows.push(`<tr class="thread-row"><td colspan="3"><div class="threads">${crHere.map((f) => findingHtml(f, true)).join('')}${threads.map(threadHtml).join('')}${S.editors.has(ek) ? editorHtml(ek, 'Add comment') : ''}</div></td></tr>`);
        }
      }
    }
    body = `<table class="diff"><colgroup><col class="num"><col class="num"><col></colgroup>${rows.join('')}</table>`;
  }
  const snippet = (line, text) => `<div class="outside-line"><span class="outside-no">${line ?? ''}</span><code>${text ? hl(text, lang) : '<span class="muted">(line not available)</span>'}</code></div>`;
  const outsideItems = [
    ...outsideFindings.map((x) => ({ line: x.startLine, html: snippet(x.startLine, x.snippet) + findingHtml(x, true) })),
    ...outsideComments.map((c) => { used.add(c.id); return { line: c.line, html: snippet(c.line, c.lineText) + threadHtml(c) }; }),
  ].sort((a, b) => (a.line || 0) - (b.line || 0));
  const out = outsideItems.length && !collapsed
    ? `<div class="outdated"><div class="outdated-label">Not on a changed line, so shown here</div><div class="threads">${outsideItems.map((i) => i.html).join('')}</div></div>` : '';
  return `<section class="file ${collapsed ? 'collapsed' : ''}" id="f-${fnv(f.uid)}">${head}<div class="file-body">${out}${body}</div></section>`;
}

// ---------- CodeRabbit ----------

const SEV_ORDER = ['critical', 'major', 'minor', 'trivial', 'info', 'none'];
const elapsed = (ms) => { const s = Math.max(0, Math.floor((Date.now() - ms) / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

function crButtonHtml(wt) {
  if (!S.st.coderabbitReady) return '<a class="btn" href="#/settings" title="Connect CodeRabbit in Settings">Set up CodeRabbit</a>';
  if (wt.coderabbit?.status === 'running') {
    return `<span class="cr-running"><span class="dot busy"></span>CodeRabbit reviewing <span class="cr-elapsed" data-start="${wt.coderabbit.startedAt}">${elapsed(wt.coderabbit.startedAt)}</span></span>
      <button class="btn small" data-act="cr-cancel">Cancel</button>`;
  }
  return `<button class="btn cr-btn" data-act="cr-run" title="Ask CodeRabbit to review these changes (uses one of your hourly CodeRabbit reviews)">Run CodeRabbit</button>`;
}

function findingHtml(f, inline = false) {
  const loc = f.file ? `${f.file}${f.startLine ? `:${f.startLine}${f.endLine && f.endLine !== f.startLine ? `–${f.endLine}` : ''}` : ''}` : '';
  const acts = f.status === 'open'
    ? `<button class="btn small primary" data-act="cr-send" data-id="${f.id}">Send to Claude</button><button class="btn small" data-act="cr-dismiss" data-id="${f.id}">Dismiss</button>`
    : f.status === 'sent' ? '<span class="muted small">Added to your review as a draft</span>'
    : `<span class="muted small">Dismissed</span><button class="link-btn" data-act="cr-restore" data-id="${f.id}">undo</button>`;
  const detail = [f.comment && f.comment !== f.title ? `<div class="msg-body">${md(f.comment)}</div>` : '',
    f.suggestions ? `<details><summary>Suggested change</summary><pre class="suggestion">${esc(f.suggestions)}</pre></details>` : '',
    f.codegen && f.codegen !== f.comment ? `<details><summary>Fix guidance for agents</summary><div class="msg-body">${md(f.codegen)}</div></details>` : ''].join('');
  return `<div class="thread cr-finding ${f.status}">
    <div class="msg"><div class="msg-head"><strong class="cr-name">CodeRabbit</strong><span class="sev ${esc(f.severity)}">${esc(f.severity)}</span>
      ${!inline && loc ? `<a href="#" class="mono" data-act="cr-jump" data-file="${esc(f.file)}" data-line="${f.endLine || f.startLine || ''}">${esc(loc)}</a>` : ''}</div>
      ${f.title ? `<div class="cr-title">${md(f.title)}</div>` : ''}
      ${f.status === 'open' || !inline ? detail : ''}</div>
    <div class="thread-actions">${acts}</div></div>`;
}

function crPanelHtml(wt) {
  const r = S.view?.cr;
  if (!r) return '';
  const findings = [...r.findings].sort((a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity));
  const open = findings.filter((f) => f.status === 'open');
  const stale = r.status !== 'running' && r.fingerprint && r.fingerprint !== wt.fingerprint;
  let head, body = '';
  if (r.status === 'running') {
    head = `CodeRabbit is reviewing against <code>${esc(r.baseRef)}</code>`;
    body = `<p class="muted">Reviews usually take 2–6 minutes and can take 15 or more. You can leave this page; findings appear here and inline as they arrive.</p>`;
  } else if (r.status === 'done') {
    head = `CodeRabbit · ${findings.length ? `${open.length} open of ${findings.length} finding${findings.length === 1 ? '' : 's'}` : 'no findings'}`;
    if (!findings.length) body = `<p class="muted">Reviewed ${r.reviewedFiles.length} file${r.reviewedFiles.length === 1 ? '' : 's'} and found nothing to flag.</p>`;
  } else {
    head = `CodeRabbit review ${r.status === 'cancelled' ? 'cancelled' : 'failed'}`;
    body = `<p class="error">${esc(r.error || 'Something went wrong.')}</p>`;
  }
  const meta = `<span class="muted small">${r.status === 'running' ? `started ${ago(r.startedAt)}` : `${ago(r.finishedAt || r.startedAt)}`}${r.usage ? ` · ${r.usage.remaining} of ${r.usage.limit} reviews left this hour` : ''}</span>`;
  return `<div class="panel cr-panel">
    <div class="panel-head"><span>${head}</span><span class="actions">${meta}${open.length > 1 ? '<button class="btn small" data-act="cr-send-all">Send all to Claude</button>' : ''}</span></div>
    <div class="panel-body">
      ${stale ? '<div class="callout warn small">The code has changed since this review. Line numbers may be off; run CodeRabbit again for a fresh look.</div>' : ''}
      ${body}
      <div class="threads cr-list">${findings.map((f) => findingHtml(f)).join('')}</div>
    </div></div>`;
}

function indexFindings() {
  const v = S.view;
  v.crByAnchor = new Map();
  for (const f of v.cr?.findings || []) {
    if (f.status !== 'open' || !f.file) continue;
    const k = keyOf(f.file, 'new', f.endLine || f.startLine);
    if (!v.crByAnchor.has(k)) v.crByAnchor.set(k, []);
    v.crByAnchor.get(k).push(f);
  }
}

async function loadCodeRabbit() {
  if (!S.view) return;
  try {
    const { review } = await api('GET', `/api/worktrees/${S.view.wtId}/coderabbit`);
    S.view.cr = review;
    indexFindings();
  } catch {}
}

setInterval(() => {
  for (const el of document.querySelectorAll('.cr-elapsed, .tick')) el.textContent = elapsed(Number(el.dataset.start));
}, 1000);

function renderMain() {
  const main = $('#main');
  if (S.page) {
    const scroll = main.scrollTop;
    main.innerHTML = S.page === 'cleanup' ? cleanupPageHtml() : setupHtml(S.page);
    main.scrollTop = scroll;
    return;
  }
  if (!S.selId) { main.innerHTML = '<div class="empty">Pick a worktree on the left.</div>'; return; }
  const wt = curWt();
  if (!wt) {
    const gone = S.st?.cleaned.find((c) => location.hash.includes(c.path));
    main.innerHTML = `<div class="empty">${gone ? 'This worktree was cleaned up after its PR merged.' : 'This worktree no longer exists.'}</div>`;
    return;
  }
  if (!S.view || S.view.wtId !== wt.id) { main.innerHTML = `<div class="page">${headerHtml(wt)}<div class="file-note">Loading diff…</div></div>`; return; }
  const v = S.view;
  const byAnchor = new Map();
  for (const c of v.comments) {
    const k = keyOf(c.file, c.side, c.line, c.commit);
    if (!byAnchor.has(k)) byAnchor.set(k, []);
    byAnchor.get(k).push(c);
  }
  const used = new Set();
  const mode = v.diff.mode;
  const since = mode === 'since';
  const byCommit = mode === 'commits';
  let filesHtml;
  if (byCommit) {
    filesHtml = v.groups.map((g) => {
      const shut = S.shutCommits.has(g.n);
      return `<section class="commit-group ${commitClass(g.n)} ${shut ? 'shut' : ''}" id="cg-${g.n}">
      <div class="commit-head"><button class="caret" data-act="toggle-commit" data-n="${g.n}" aria-expanded="${!shut}" aria-label="${shut ? 'Expand' : 'Collapse'} this commit" title="${shut ? 'Expand' : 'Collapse'} this commit">${shut ? '▸' : '▾'}</button><span class="cnum">${g.n ? `#${g.n}` : '±'}</span>
        <span class="commit-title">${esc(g.subject)}</span>
        <span class="muted small">${g.sha ? `<span class="mono">${g.sha.slice(0, 8)}</span> · ${esc(g.author)} · ${ago(g.time)} · ` : ''}${g.files.length} file${g.files.length === 1 ? '' : 's'}</span></div>
      ${shut || !g.body ? '' : commitBodyHtml(g)}
      ${shut ? '' : `<div class="commit-files">${g.truncated ? '<div class="callout warn small">This commit is too large to show in full.</div>' : ''}
      ${g.files.map((f) => renderFile(f, byAnchor, used)).join('') || '<div class="file-note">No file changes.</div>'}</div>`}
    </section>`;
    }).join('') + (v.diff.hiddenCommits ? `<div class="callout small">${v.diff.hiddenCommits} older commits aren't shown.</div>` : '');
  } else {
    filesHtml = v.files.map((f) => renderFile(f, byAnchor, used)).join('');
  }
  const unplaced = v.comments.filter((c) => !used.has(c.id) && c.status !== 'resolved');
  // Comments that belong to this view but whose file isn't shown, vs comments made in the other view.
  const orphan = unplaced.filter((c) => (byCommit ? !!c.commit : !c.commit));
  const otherView = unplaced.filter((c) => (byCommit ? !c.commit : !!c.commit));
  const viewedCount = v.files.filter((f) => v.diff.viewed[f.path] === f.hash).length;

  v.headerSig = headerSig(wt);
  const scroll = main.scrollTop;
  main.innerHTML = `<div class="page" ${S.hl !== null && S.hl !== undefined && !byCommit ? `data-hl="${S.hl}"` : ''}>
    ${headerHtml(wt)}
    ${commitsHtml(v.diff.commits, wt)}
    <div class="toolbar">
      <div class="actions">
        <div class="seg">
          <button data-act="mode" data-mode="full" class="${since || byCommit ? '' : 'on'}">All changes</button>
          <button data-act="mode" data-mode="commits" class="${byCommit ? 'on' : ''}" ${v.diff.commits.length || wt.dirty ? '' : 'disabled'} title="Each commit's changes in the order they were made">By commit</button>
          <button data-act="mode" data-mode="since" class="${since ? 'on' : ''}" ${v.diff.sinceAvailable ? '' : 'disabled title="Mark as reviewed first"'}>Since last review${v.diff.reviewedAt ? ` (${ago(v.diff.reviewedAt)})` : ''}</button>
        </div>
        ${byCommit ? `<span class="progress">${v.diff.commits.length} commit${v.diff.commits.length === 1 ? '' : 's'}, oldest first</span>` : `<span class="progress">${viewedCount} / ${v.files.length} files viewed</span>`}
      </div>
      <div class="actions">
        ${S.stale ? '<span class="banner">New changes landed. <button class="btn small" data-act="refresh">Refresh</button></span>' : ''}
        ${crButtonHtml(wt)}
        ${byCommit && v.groups.every((g) => S.shutCommits.has(g.n))
          ? '<button class="btn" data-act="expand-all">Expand all</button>'
          : '<button class="btn" data-act="collapse-all">Collapse all</button>'}
        <button class="btn" data-act="mark-reviewed" title="Remember this exact state so you can see only what changes next">Mark as reviewed</button>
      </div>
    </div>
    ${crPanelHtml(wt)}
    ${v.diff.truncated ? '<div class="callout warn">This diff is very large and was cut off.</div>' : ''}
    ${orphan.length ? `<div class="panel"><div class="panel-head">Comments on files not in this view</div><div class="panel-body threads">${orphan.map((c) => `<div class="mono">${esc(c.file)}:${c.line}</div>${threadHtml(c)}`).join('')}</div></div>` : ''}
    ${otherView.length ? `<details class="panel"><summary class="panel-head" style="cursor:pointer">${otherView.length} comment${otherView.length === 1 ? '' : 's'} made in the ${byCommit ? 'All changes' : 'By commit'} view
        <button class="btn small" data-act="mode" data-mode="${byCommit ? 'full' : 'commits'}">Show there</button></summary>
      <div class="panel-body threads">${otherView.map((c) => `<div class="mono">${esc(c.file)}:${c.line}${c.commit ? ` · ${c.commit.slice(0, 8)}` : ''}</div>${threadHtml(c)}`).join('')}</div></details>` : ''}
    ${byCommit ? filesHtml : v.files.length ? filesSummaryHtml(v) + filesHtml : `<div class="callout">${since ? 'Nothing has changed since your last review.' : `No changes against <code>${esc(v.diff.baseRef)}</code>.`}</div>`}
  </div>
  ${reviewBarHtml(wt)}`;
  main.scrollTop = scroll;
  applyHighlight();
  if (S.scrollTo) {
    document.getElementById(S.scrollTo)?.scrollIntoView({ block: 'start' });
    S.scrollTo = null;
  }

  if (S.focusEk) {
    const ta = main.querySelector(`textarea[data-ek="${CSS.escape(S.focusEk)}"]`);
    if (ta) { ta.focus(); ta.selectionStart = ta.selectionEnd = ta.value.length; }
    S.focusEk = null;
  }
}

const headerSig = (wt) => JSON.stringify([wt.sessions, wt.pr, wt.cleanup, wt.ahead, wt.dirty, wt.baseRef, wt.baseError, wt.error, wt.busy, S.removeErrors[wt.id], S.st.sessions.length, S.st.config]);

function headerHtml(wt) {
  const name = wt.branch || `detached @ ${wt.head?.slice(0, 10)}`;
  const pr = wt.pr ? ` <a class="pr-no" href="${esc(wt.pr.url)}" target="_blank">#${wt.pr.number}</a>` : '';
  const cs = wt.cleanup;
  let cleanup = '';
  const err = wt.error
    ? `<div class="callout danger"><strong>${wt.error.kind === 'broken-link' ? 'Git can\'t read this worktree' : 'Git reported a problem with this worktree'}</strong>
        <p>${esc(wt.error.message)}</p>
        ${wt.error.detail && wt.error.detail !== wt.error.message ? `<details><summary>Git's message</summary><code class="cmd">${esc(wt.error.detail)}</code></details>` : ''}
        ${wt.error.kind === 'broken-link' ? '<div class="actions" style="margin-top:8px"><button class="btn primary" data-act="repair">Repair links</button></div>' : ''}</div>`
    : '';
  const removeErr = S.removeErrors[wt.id] ? `<div class="callout danger"><strong>Couldn't remove this worktree.</strong><p>${esc(S.removeErrors[wt.id])}</p></div>` : '';
  if (cs?.kind === 'idle' && !wt.sessions.length && (cs.eligible || cs.forceable)) {
    cleanup = `<div class="callout small">No Claude session is using this worktree.
      ${wt.busy ? '<span class="muted"><span class="dot busy"></span> Removing…</span>'
        : cs.eligible ? '<button class="link-btn" data-act="remove">Remove it</button> (the branch is kept)'
        : `<button class="link-btn" data-act="remove-anyway">Remove anyway…</button> <span class="muted">(${esc(cs.reasons.join('; '))})</span>`}
      · <a class="link-btn" href="#/cleanup">Clean up others</a></div>`;
  } else if (cs?.kind === 'merged') {
    const STATUS = { ' M': 'modified', 'M ': 'staged', MM: 'staged + modified', 'A ': 'new, staged', AM: 'new, staged', ' D': 'missing', 'D ': 'deleted, staged', '??': 'untracked', 'R ': 'renamed' };
    const files = cs.dirty ? `<details ${cs.dirty.kind === 'work' && cs.dirty.count <= 20 ? 'open' : ''}><summary>${cs.dirty.count} uncommitted file${cs.dirty.count === 1 ? '' : 's'}</summary>
        <ul class="file-list">${cs.dirty.files.map((f) => `<li><code>${esc(f.file)}</code> <span class="muted small">${esc(STATUS[f.xy] || f.xy.trim())}</span></li>`).join('')}${cs.dirty.count > cs.dirty.files.length ? `<li class="muted">…and ${cs.dirty.count - cs.dirty.files.length} more</li>` : ''}</ul></details>` : '';
    const commits = cs.unmatched?.length ? `<details><summary>${cs.unmatched.length} commit${cs.unmatched.length === 1 ? '' : 's'} with no matching change in the PR (kept on the branch)</summary>
        <ul class="file-list">${cs.unmatched.map((c) => `<li><code>${esc(c.sha.slice(0, 8))}</code> ${esc(c.subject)}</li>`).join('')}</ul></details>` : '';
    const notes = cs.notes.length ? `<ul class="notes">${cs.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : '';
    const busy = wt.busy ? '<span class="muted"><span class="dot busy"></span> Removing…</span>' : '';
    cleanup = cs.eligible
      ? `<div class="callout merged"><strong>PR merged.</strong> Nothing uncommitted would be lost and nothing is using it. ${cs.auto && S.st.config.autoCleanup ? 'It will be removed automatically in a moment.' : 'It was merged before auto-cleanup was set up, so it waits for you.'}
          ${notes}${files}${commits}
          <div class="actions" style="margin-top:8px">${busy || `<button class="btn danger" data-act="remove">Remove worktree${cs.branchSafe ? ' and branch' : ''}</button>`}</div></div>`
      : `<div class="callout warn"><strong>PR merged, but removing this worktree could lose something:</strong>
          <ul>${cs.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>${notes}${files}${commits}
          ${cs.forceable ? `<div class="actions" style="margin-top:8px">${busy || '<button class="btn danger" data-act="remove-anyway">Remove anyway…</button><span class="muted small">The branch is kept either way.</span>'}</div>` : ''}</div>`;
  }
  return `<div class="title-row"><h1>${esc(name)}${pr}</h1>
      <div class="actions">${prChip(wt.pr)}${wt.sessions.map(sessionChip).join('')}</div></div>
    ${wt.pr ? `<div class="meta">${esc(wt.pr.title)}</div>` : ''}
    <div class="meta">
      <span>${esc(wt.repoName)}</span>
      <span class="mono" title="${esc(wt.path)}">${esc(tilde(wt.path))}</span>
      <button class="link-btn" data-act="copy-path">copy path</button>
      ${editorLink(wt.path) ? `<a href="${esc(editorLink(wt.path))}">open in ${editorName()}</a>` : ''}
      <span class="base-edit">base <input id="base" value="${esc(wt.baseRef || '')}" title="${esc(wt.baseSource || '')}" spellcheck="false"><button class="btn small" data-act="set-base">Set</button>${wt.baseSource === 'set by you' ? '<button class="link-btn" data-act="reset-base">reset</button>' : `<span>(${esc(wt.baseSource || '')})</span>`}</span>
      <span>${wt.ahead} commit${wt.ahead === 1 ? '' : 's'}${wt.dirty ? ` + ${wt.dirty} uncommitted` : ''}</span>
      <span>updated ${ago(wt.lastActivity)}</span>
    </div>
    ${err}${removeErr}
    ${wt.baseError && !wt.error ? `<div class="callout warn">${esc(wt.baseError)}. Set a different base above.</div>` : ''}
    ${cleanup}`;
}

function commitsHtml(commits, wt) {
  if (!commits.length && !wt.dirty) return '';
  const byCommit = S.view?.diff.mode === 'commits';
  const canHl = !byCommit && !!S.view?.blame;
  const row = (n, sha, subject, time, body) => `<div class="commit ${S.hl === n && canHl ? 'hl' : ''}" ${body ? `title="${esc(`${subject}\n\n${body}`)}"` : ''}>
      <button class="cswatch ${commitClass(n)}" data-act="hl-commit" data-n="${n}" ${canHl ? '' : 'disabled'} title="${canHl ? 'Highlight the lines from this commit' : byCommit ? '' : 'Working out which lines came from which commit…'}">${n ? `#${n}` : '±'}</button>
      ${sha ? `<span class="mono">${sha.slice(0, 8)}</span>` : ''}<span class="subject">${esc(subject)}</span>
      <span class="when">${time ? ago(time) : ''}</span>
      <button class="link-btn" data-act="view-commit" data-n="${n}">view</button></div>`;
  const rows = commits.map((c) => row(c.n, c.sha, c.subject, c.time, c.body));
  if (wt.dirty) rows.push(row(0, null, `Uncommitted changes (${wt.dirty} file${wt.dirty === 1 ? '' : 's'})`, null));
  return `<details class="panel commits-panel" ${commits.length <= 8 ? 'open' : ''}><summary class="panel-head" style="cursor:pointer">${commits.length} commit${commits.length === 1 ? '' : 's'}, oldest first
      ${S.hl !== null && S.hl !== undefined && canHl ? '<button class="btn small" data-act="hl-commit" data-n="">Clear highlight</button>' : ''}</summary>
    <div class="panel-body">${rows.join('')}</div></details>`;
}

const TRAILER = /^[A-Z][A-Za-z-]+: .+/;
function commitBodyHtml(g) {
  const lines = g.body.split('\n');
  // Trailers (Co-Authored-By:, Signed-off-by:, Refs:) are the last paragraph of key: value lines.
  let cut = lines.length;
  while (cut > 0 && (TRAILER.test(lines[cut - 1]) || !lines[cut - 1].trim())) cut--;
  const trailerBlock = lines.slice(cut).filter((l) => l.trim());
  const isTrailers = trailerBlock.length && trailerBlock.every((l) => TRAILER.test(l));
  const main = (isTrailers ? lines.slice(0, cut) : lines).join('\n').trim();
  const long = main.split('\n').length > 6 || main.length > 600;
  const open = S.openBodies.has(g.n);
  return `<div class="commit-body ${long && !open ? 'clamped' : ''} ${main ? '' : 'trailers-only'}">
    ${main ? `<div class="commit-msg">${md(main)}</div>` : ''}
    ${isTrailers ? `<div class="commit-trailers">${trailerBlock.map(esc).join('<br>')}</div>` : ''}
    ${long ? `<button class="link-btn" data-act="toggle-body" data-n="${g.n}">${open ? 'Show less' : 'Show full message'}</button>` : ''}
  </div>`;
}

function applyHighlight() {
  let el = document.getElementById('hl-style');
  if (!el) { el = document.createElement('style'); el.id = 'hl-style'; document.head.appendChild(el); }
  const n = S.hl;
  el.textContent = n === null || n === undefined ? '' : `
    .page[data-hl="${n}"] tr.line.add:not([data-c="${n}"]) td, .page[data-hl="${n}"] tr.line.del td { opacity: .28; }
    .page[data-hl="${n}"] tr.line.add[data-c="${n}"] td.code { box-shadow: inset 3px 0 0 var(--c-hl, currentColor); }`;
}

function filesSummaryHtml(v) {
  if (v.files.length < 2) return '';
  return `<details class="panel files-summary" ${v.files.length <= 25 ? 'open' : ''}><summary class="panel-head" style="cursor:pointer">${v.files.length} files changed
      <span><span class="stat-add">+${v.files.reduce((n, f) => n + f.add, 0)}</span> <span class="stat-del">−${v.files.reduce((n, f) => n + f.del, 0)}</span></span></summary>
    <div class="panel-body">${v.files.map((f) => {
      const viewed = v.diff.viewed[f.path] === f.hash;
      const nc = v.comments.filter((c) => c.file === f.path && c.status !== 'resolved').length;
      return `<div class="row ${viewed ? 'viewed' : ''}"><input type="checkbox" data-act="viewed" data-file="${esc(f.path)}" ${viewed ? 'checked' : ''} title="Viewed">
        <a href="#" data-act="jump" data-file="${esc(f.path)}">${esc(f.path)}</a>${nc ? `<span class="chip comments">${nc}</span>` : ''}
        <span class="stat-add">+${f.add}</span><span class="stat-del">−${f.del}</span></div>`;
    }).join('')}</div></details>`;
}

function reviewBarHtml(wt) {
  const v = S.view;
  const drafts = v.comments.filter((c) => c.status === 'draft');
  const summary = S.summaries[wt.id] || '';
  const pending = v.reviews;
  const live = S.st.sessions;
  const linked = wt.sessions;
  const open = drafts.length || summary || pending.length;
  const target = S.summaries[`${wt.id}:target`] || '';
  const options = [`<option value="">${linked.length ? `Claude session working here (${linked.map((s) => esc(s.name)).join(', ')})` : 'First Claude session that works here'}</option>`]
    .concat(live.map((s) => `<option value="${esc(s.sessionId)}" ${target === s.sessionId ? 'selected' : ''}>${esc(s.name)} (${esc(s.status)})${linked.some((l) => l.sessionId === s.sessionId) ? ' · working here' : ''}</option>`));
  return `<details class="review-bar" ${open ? 'open' : ''}>
    <summary><span>Review</span><span class="progress">${drafts.length} draft comment${drafts.length === 1 ? '' : 's'}${pending.length ? ` · ${pending.length} waiting` : ''}</span></summary>
    <div class="body">
      <textarea data-ek="summary" placeholder="Overall feedback (optional)">${esc(summary)}</textarea>
      <div class="actions">
        <select data-act="target" title="Which Claude session gets this review">${options.join('')}</select>
        <span style="flex:1"></span>
        <button class="btn" data-act="copy-prompt" ${drafts.length || pending.length ? '' : 'disabled'}>Copy as prompt</button>
        <button class="btn primary" data-act="submit" ${drafts.length || summary.trim() ? '' : 'disabled'}>Send to Claude</button>
      </div>
      <div class="note">${linked.length
        ? 'Delivered when that session finishes what it\'s doing, or with your next message to it.'
        : 'No Claude session is working in this worktree right now. It\'ll go to the first one that does, or copy it as a prompt.'}</div>
      ${pending.length ? `<div class="pending-list">${pending.map((r) => `<div>Review with ${r.commentIds.length} comment${r.commentIds.length === 1 ? '' : 's'} waiting since ${ago(r.createdAt)} · <button class="link-btn" data-act="cancel-review" data-id="${r.id}">take back</button></div>`).join('')}</div>` : ''}
    </div>
  </details>`;
}

// ---------- settings & onboarding ----------

const ICON_OK = '<span class="check ok" aria-label="Done">✓</span>';
const ICON_TODO = '<span class="check todo" aria-label="Needs attention">!</span>';
const ICON_OPT = '<span class="check opt" aria-label="Optional">–</span>';
const ICON_WAIT = '<span class="check wait" aria-label="Checking">…</span>';

async function loadIntegrations(refresh = false) {
  try {
    S.integ = await api('GET', `/api/integrations${refresh ? '?refresh=1' : ''}`);
  } catch (e) { toast(e.message, true); }
  if (S.page) renderMain();
}

function stepHtml(icon, title, body, extra = '') {
  return `<section class="step"><div class="step-icon">${icon}</div><div class="step-main"><h2>${title}</h2>${body}${extra}</div></section>`;
}

const cmd = (c) => `<code class="cmd">${esc(c)}</code><button class="link-btn" data-act="copy-text" data-text="${esc(c)}">copy</button>`;

function foldersHtml() {
  const c = S.st.config;
  const row = (key, p) => `<div class="folder-row"><code title="${esc(expandHome(p))}">${esc(tilde(expandHome(p)))}</code><button class="link-btn" data-act="remove-folder" data-key="${key}" data-path="${esc(p)}">remove</button></div>`;
  return `<div class="folders">
    ${c.roots.map((p) => row('roots', p)).join('')}${c.extraRepos.map((p) => row('extraRepos', p)).join('')}
    <div class="folder-add">
      <button class="btn small" data-act="open-picker">Choose a folder…</button>
      <span class="muted small">A repo, or a folder of repos.</span>
    </div>
  </div>`;
}

function setupHtml(mode) {
  const st = S.st;
  const I = S.integ;
  const c = st.config;
  const welcome = mode === 'welcome';
  const steps = [];

  // 1. Worktrees
  const nRepos = st.repos.length;
  steps.push(stepHtml(st.worktrees.length ? ICON_OK : ICON_TODO, 'Your worktrees',
    `<p>${st.worktrees.length
      ? `Found <strong>${st.worktrees.length} worktree${st.worktrees.length === 1 ? '' : 's'}</strong> in ${nRepos} repo${nRepos === 1 ? '' : 's'}, from the folders your Claude Code sessions have worked in over the last 30 days.`
      : 'No worktrees yet. Repos appear here once a Claude Code session has worked in them, or add a folder below.'}</p>
     ${nRepos ? `<div class="repo-list">${st.repos.map((r) => `<div><strong>${esc(r.name)}</strong> <code>${esc(tilde(r.root))}</code>${r.github ? ` <span class="muted">${esc(r.github)}</span>` : ''}</div>`).join('')}</div>` : ''}
     <details ${welcome && st.worktrees.length ? '' : 'open'}><summary>Also scan these folders</summary>${foldersHtml()}</details>`));

  // 2. Claude Code
  const hookAgo = I?.claude.lastHookAt ? ago(I.claude.lastHookAt) : null;
  steps.push(stepHtml(!I ? ICON_WAIT : (st.sessions.length || hookAgo) ? ICON_OK : ICON_TODO, 'Claude Code',
    `<p>${st.sessions.length} live session${st.sessions.length === 1 ? '' : 's'}.
      Reviews you send are handed to the session working in that worktree when it finishes its current turn, or with your next message to it.</p>
     <p class="muted">${hookAgo ? `Last heard from a session's hook ${hookAgo}.` : "Haven't heard from a session's hook yet. That happens the next time you send a message in a session started after installing the plugin."}</p>`));

  // 3. GitHub
  let ghBody;
  if (!I) ghBody = '<p class="muted">Checking…</p>';
  else if (!I.gh.installed) ghBody = `<p>Install the GitHub CLI to see PR status and clean up merged worktrees: ${cmd('brew install gh')} then ${cmd('gh auth login')}</p>`;
  else if (!I.gh.authed) ghBody = `<p>The GitHub CLI isn't signed in. Run ${cmd('gh auth login')} in a terminal, then check again.</p>`;
  else ghBody = `<p>Signed in as <strong>${esc(I.gh.account || 'unknown')}</strong>. PR status and merged-worktree cleanup are available.</p>`;
  steps.push(stepHtml(!I ? ICON_WAIT : I.gh.authed ? ICON_OK : ICON_TODO, 'GitHub',
    ghBody + `<label class="setting"><input type="checkbox" data-cfg="autoCleanup" ${c.autoCleanup ? 'checked' : ''}>
      <span><strong>Remove worktrees when their PR merges</strong><br><span class="muted">Only when the worktree is clean, no Claude session is using it, its HEAD is in the merged PR and it has no unsent comments. PRs merged before you installed this are left for you to remove.</span></span></label>`));

  // 4. CodeRabbit
  const login = st.coderabbitLogin;
  let crBody, crIcon = ICON_OPT;
  if (!I) { crBody = '<p class="muted">Checking…</p>'; crIcon = ICON_WAIT; }
  else if (!I.coderabbit.installed) {
    crBody = `<p>Optional. With the CodeRabbit CLI you can ask CodeRabbit to review a worktree before it's a PR, and send its findings to Claude.</p>
      <p>Install it with ${cmd('brew install coderabbit')} or ${cmd('curl -fsSL https://cli.coderabbit.ai/install.sh | sh')}, then <button class="link-btn" data-act="recheck">check again</button>.</p>`;
  } else if (!I.coderabbit.authed) {
    crBody = `<p>CodeRabbit CLI ${esc(I.coderabbit.version || '')} is installed. Sign in to use it here. If your company has CodeRabbit on GitHub, reviews of its repos use the company plan.</p>
      ${login?.running
        ? `<p><strong>Finish signing in in the browser window that opened.</strong> ${login.url ? `<a href="${esc(login.url)}" target="_blank">Open the sign-in page</a> if it didn't.` : ''}</p>`
        : `<div class="actions"><button class="btn primary" data-act="cr-login">Sign in to CodeRabbit</button></div>`}
      ${login?.error ? `<p class="error">${esc(login.error)}</p>` : ''}`;
  } else {
    crIcon = ICON_OK;
    const cr = I.coderabbit;
    crBody = `<table class="kv">
        <tr><td>Account</td><td><strong>${esc(cr.user)}</strong>${cr.email ? ` <span class="muted">${esc(cr.email)}</span>` : ''}</td></tr>
        <tr><td>Organization</td><td>${esc(cr.org || '—')}${cr.orgs?.length > 1 ? ` <span class="muted">(also: ${cr.orgs.filter((o) => o !== cr.org).map(esc).join(', ')})</span>` : ''}</td></tr>
        ${cr.plan ? `<tr><td>Plan</td><td>${esc(cr.plan)}${cr.seat ? ` · seat ${esc(cr.seat)}` : ''}</td></tr>` : ''}
        <tr><td>CLI</td><td>${esc(cr.version || '')}</td></tr>
      </table>
      <p class="muted">Reviews count against the organization that owns each repo. To change your default organization, run ${cmd('coderabbit auth org')} in a terminal.</p>
      ${welcome ? '' : '<div class="actions"><button class="btn small" data-act="cr-logout">Sign out</button></div>'}`;
  }
  steps.push(stepHtml(crIcon, 'CodeRabbit <span class="muted small">optional</span>', crBody));

  // 5. Preferences
  const notif = !('Notification' in window) ? 'unsupported' : Notification.permission;
  steps.push(stepHtml(ICON_OK, 'Preferences', `
    <label class="setting row"><span>Open files in</span>
      <select data-cfg="editor">${[['vscode', 'VS Code'], ['cursor', 'Cursor'], ['windsurf', 'Windsurf'], ['zed', 'Zed'], ['none', 'No editor links']].map(([v, l]) => `<option value="${v}" ${c.editor === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <div class="setting row"><span>Desktop notifications when a session finishes work you haven't reviewed</span>
      ${notif === 'granted' ? '<span class="muted">On</span>' : notif === 'denied' ? '<span class="muted">Blocked in browser settings</span>' : notif === 'unsupported' ? '<span class="muted">Not supported here</span>' : '<button class="btn small" data-act="enable-notifications">Turn on</button>'}</div>
    ${welcome ? '' : `
    <label class="setting row"><span>Count a worktree as recent for</span><span><input type="number" min="1" max="90" data-cfg="recentDays" value="${c.recentDays}"> days</span></label>
    <label class="setting row"><span>Check PR status every</span><span><input type="number" min="1" max="60" data-cfg="prPollMinutes" value="${c.prPollMinutes}"> minutes</span></label>`}`));

  if (!welcome) {
    steps.push(stepHtml(ICON_OK, 'About', `<table class="kv">
      <tr><td>Version</td><td>${esc(st.version)}</td></tr>
      <tr><td>Data</td><td><code>${esc(tilde(I?.dataDir || ''))}</code></td></tr>
      <tr><td>Node</td><td>${esc(I?.node || '')}</td></tr></table>
      <div class="actions"><button class="btn small" data-act="rerun-setup">Run setup again</button></div>`));
  }

  return `<div class="page setup">
    <div class="title-row"><h1>${welcome ? 'Welcome to Worktree Review' : 'Settings'}</h1>
      <button class="btn small" data-act="recheck">Check again</button></div>
    <p class="lede">${welcome
      ? 'Review what Claude is doing in your git worktrees the way you\'d review a PR, then send comments straight back to the session. A quick check of what\'s connected:'
      : 'Integrations and preferences. Changes save as you make them.'}</p>
    ${steps.join('')}
    ${welcome ? '<div class="actions finish"><button class="btn primary" data-act="finish-setup">Start reviewing</button></div>' : ''}
  </div>`;
}

function setupSig(st) {
  if (S.page === 'cleanup') return JSON.stringify([st.jobs, st.worktrees.map((w) => [w.id, w.cleanup, w.busy, w.sessions.length, w.pr?.state])]);
  return JSON.stringify([st.coderabbitLogin, st.config, st.repos, st.sessions.length, st.worktrees.length, st.onboardedAt]);
}

async function saveConfig(patch) {
  try {
    await api('POST', '/api/config', patch);
    toast('Saved');
  } catch (e) { toast(e.message, true); }
}

// ---------- background jobs (sidebar progress) ----------

function jobHtml(j) {
  const pct = j.total ? Math.round((j.done / j.total) * 100) : 100;
  const running = j.status === 'running';
  const verb = j.kind === 'repair' ? 'Repaired' : 'Removed';
  const line = running
    ? `${j.current ? `${j.kind === 'repair' ? 'Repairing' : 'Removing'} <strong>${esc(j.current.branch || tilde(j.current.path))}</strong>` : 'Starting…'} · ${j.done + 1 > j.total ? j.total : j.done + 1} of ${j.total}`
    : `${verb} ${j.ok.length}${j.failed.length ? ` · <span class="bad">${j.failed.length} failed</span>` : ''}`;
  return `<div class="job ${running ? 'running' : j.failed.length ? 'failed' : 'ok'}">
    <div class="job-top"><span class="job-title">${esc(j.title)}</span>
      <span class="muted small">${running ? `<span class="tick" data-start="${j.startedAt}">${elapsed(j.startedAt)}</span>` : elapsedBetween(j.startedAt, j.finishedAt)}</span></div>
    <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="${j.total}" aria-valuenow="${j.done}"><div class="fill" style="width:${running ? Math.max(pct, 4) : 100}%"></div></div>
    <div class="job-line">${line}</div>
    ${j.failed.slice(0, 3).map((f) => `<div class="job-fail"><button class="link-btn" data-act="result-open" data-id="${esc(f.id)}">${esc(f.branch || tilde(f.path))}</button>: ${esc(f.error)}</div>`).join('')}
    ${!running ? `<div class="actions">${j.failed.length > 3 || j.ok.length ? `<button class="link-btn" data-act="job-details" data-id="${j.id}">Details</button>` : ''}<span style="flex:1"></span><button class="link-btn" data-act="job-dismiss" data-id="${j.id}">Dismiss</button></div>` : ''}
  </div>`;
}
const elapsedBetween = (a, b) => { const s = Math.max(0, Math.round(((b || Date.now()) - a) / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; };

function renderJobs() {
  const el = $('#jobs');
  if (!el) return;
  const list = S.st?.jobs || [];
  el.innerHTML = list.map(jobHtml).join('');
  for (const j of list) {
    if (j.status !== 'done' || S.seenJobs.has(j.id)) continue;
    S.seenJobs.add(j.id);
    for (const f of j.failed) S.removeErrors[f.id] = f.error;
    for (const o of j.ok) delete S.removeErrors[o.id];
    if (!j.failed.length) setTimeout(() => api('POST', `/api/jobs/${j.id}/dismiss`).catch(() => {}), 6000);
    if (j.failed.length && S.selId && j.failed.some((f) => f.id === S.selId)) renderMain();
  }
}

// ---------- clean-up page ----------
// Every worktree no Claude session is using, merged or not, sorted by whether it can go.

function cleanupGroups() {
  const g = { ready: [], look: [], blocked: [] };
  for (const w of S.st.worktrees) {
    const cs = w.cleanup;
    if (!cs || w.sessions.length) continue;
    (cs.eligible && !w.busy ? g.ready : cs.forceable ? g.look : g.blocked).push(w);
  }
  for (const k of Object.keys(g)) g[k].sort((a, b) => a.lastActivity - b.lastActivity);
  return g;
}

// Picked unless you unticked it. Anything touched in the last few days starts unticked.
function cleanPicked(w) {
  if (S.cleanSel.has(w.id)) return S.cleanSel.get(w.id);
  return w.cleanup.kind === 'merged' || w.pr?.state === 'CLOSED' || Date.now() - w.lastActivity > S.st.config.recentDays * 864e5;
}

function cleanRow(w, { pick = false, open = false } = {}) {
  const cs = w.cleanup;
  const name = w.branch || `detached @ ${w.head?.slice(0, 8) || '?'}`;
  const notes = [...(pick ? [] : cs.reasons), ...cs.notes];
  return `<label class="clean-row ${pick ? '' : 'static'}">
    ${pick ? `<input type="checkbox" data-act="clean-pick" data-id="${w.id}" ${cleanPicked(w) ? 'checked' : ''}>` : ''}
    <div class="clean-main">
      <div><strong>${esc(name)}</strong> ${prChip(w.pr)} ${w.busy ? '<span class="chip busy-chip"><span class="dot busy"></span>removing…</span>' : ''}
        <span class="muted small">${esc(w.repoName)} · ${esc(shortPath(w.path))} · ${ago(w.lastActivity)}</span>
        ${open ? `<a class="link-btn" href="#/${w.id}">open</a>` : ''}</div>
      ${notes.length ? `<ul class="notes">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
    </div></label>`;
}

function cleanupPageHtml() {
  const g = cleanupGroups();
  const picked = g.ready.filter(cleanPicked).length;
  const running = S.st.jobs.some((j) => j.kind === 'cleanup' && j.status === 'running');
  const inUse = S.st.worktrees.filter((w) => w.cleanup && w.sessions.length).length;
  const sec = (title, sub, items, opts) => items.length ? `<section class="clean-sec"><h2>${title} <span class="count">${items.length}</span>${opts.tools || ''}</h2>
      ${sub ? `<p class="muted small">${sub}</p>` : ''}${items.map((w) => cleanRow(w, opts)).join('')}</section>` : '';
  return `<div class="page setup clean-page">
    <h1>Clean up worktrees</h1>
    <p class="muted">Worktrees no Claude session is using${inUse ? ` (${inUse} in use ${inUse === 1 ? 'is' : 'are'} left out)` : ''}. Removing one deletes its folder.
      Branches are kept, except a merged branch whose commits are all in its PR, and every removal can be restored from <em>Cleaned up</em> in the sidebar.</p>
    ${!g.ready.length && !g.look.length && !g.blocked.length ? '<div class="empty">Nothing to clean up.</div>' : ''}
    ${sec('Ready to remove', `Nothing uncommitted would be lost. Ones changed in the last ${S.st.config.recentDays} days start unticked.`, g.ready, {
      pick: true,
      tools: ` <span class="clean-tools"><button class="link-btn" data-act="clean-all" data-on="1">all</button> <button class="link-btn" data-act="clean-all" data-on="0">none</button></span>`,
    })}
    ${sec('Need a look first', 'Removing these would lose uncommitted changes or unsent comments. Open one to see the files and use <em>Remove anyway</em>.', g.look, { open: true })}
    ${sec("Can't be removed", '', g.blocked, { open: true })}
    ${g.ready.length ? `<div class="clean-foot"><button class="btn danger" data-act="clean-run" ${picked && !running ? '' : 'disabled'}>Remove ${picked} worktree${picked === 1 ? '' : 's'}</button>
      ${running ? '<span class="muted small">A clean-up is running; see the sidebar.</span>' : ''}</div>` : ''}
  </div>`;
}

// ---------- results dialog (bulk cleanup / repair) ----------

function showResult({ title, busy, ok = [], okLabel, failed = [], failedLabel, note }) {
  let el = $('#result');
  if (!el) {
    el = document.createElement('div');
    el.id = 'result';
    el.className = 'modal-backdrop';
    el.addEventListener('click', (e) => { if (e.target === el && !el.dataset.busy) closeResult(); });
    document.body.appendChild(el);
  }
  el.dataset.busy = busy ? '1' : '';
  const item = (x, bad) => `<div class="result-item ${bad ? 'bad' : ''}">
      <div><strong>${esc(x.branch || tilde(x.path))}</strong> <span class="muted mono">${esc(tilde(x.path))}</span></div>
      ${bad ? `<div class="result-err">${esc(x.error)}</div><button class="link-btn" data-act="result-open" data-id="${esc(x.id)}">Open this worktree</button>` : ''}
    </div>`;
  el.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="modal-head"><span>${esc(title)}</span>${busy ? '' : '<button class="link-btn" data-act="close-result" aria-label="Close">✕</button>'}</div>
    <div class="dir-list result-list">
      ${busy ? '<div class="file-note">Working… removing a worktree can take a few seconds each.</div>' : `
        ${failed.length ? `<h3 class="result-h bad">${failedLabel} (${failed.length})</h3>${failed.map((x) => item(x, true)).join('')}` : ''}
        ${ok.length ? `<h3 class="result-h">${okLabel} (${ok.length})</h3>${ok.map((x) => item(x, false)).join('')}` : ''}
        ${!ok.length && !failed.length ? '<div class="file-note">Nothing to do.</div>' : ''}
        ${note ? `<p class="muted small">${esc(note)}</p>` : ''}`}
    </div>
    ${busy ? '' : '<div class="modal-foot"><div class="actions" style="justify-content:flex-end"><button class="btn" data-act="close-result">Close</button></div></div>'}
  </div>`;
}
function closeResult() { $('#result')?.remove(); }

// ---------- folder picker ----------

const expandHome = (p) => (p.startsWith('~') && S.st?.home ? S.st.home + p.slice(1) : p);
const FOLDER_ICON = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z"/></svg>';
const REPO_ICON = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z"/></svg>';

async function openPicker(p) {
  S.picker ||= { hidden: false };
  try {
    S.picker.data = await api('GET', `/api/fs?path=${encodeURIComponent(p)}${S.picker.hidden ? '&hidden=1' : ''}`);
  } catch (e) { toast(e.message, true); if (S.picker.data) return; S.picker.data = null; return; }
  renderPicker();
}

function closePicker() {
  $('#picker')?.remove();
}

function renderPicker() {
  const d = S.picker.data;
  const home = S.st.home;
  const parts = d.display.split('/').filter(Boolean);
  const crumbs = parts.map((name, i) => {
    const target = i === 0 ? home : `${home}/${parts.slice(1, i + 1).join('/')}`;
    return i === parts.length - 1 ? `<strong>${esc(name)}</strong>` : `<button class="link-btn" data-act="picker-go" data-path="${esc(target)}">${esc(name)}</button>`;
  }).join('<span class="muted">/</span>');
  const added = [...S.st.config.roots, ...S.st.config.extraRepos].map(expandHome);
  const already = added.includes(d.path);
  const verdict = d.isRepo
    ? `<strong>${esc(d.display)}</strong> is a git repo. Its worktrees will be listed.`
    : d.repoChildren
      ? `<strong>${esc(d.display)}</strong> contains ${d.repoChildren} git repo${d.repoChildren === 1 ? '' : 's'}. All of them, and their worktrees, will be listed.`
      : `No git repos directly inside <strong>${esc(d.display)}</strong>. Open a folder that has some, or pick a repo.`;
  let el = $('#picker');
  if (!el) {
    el = document.createElement('div');
    el.id = 'picker';
    el.className = 'modal-backdrop';
    el.addEventListener('click', (e) => { if (e.target === el) closePicker(); });
    document.body.appendChild(el);
  }
  el.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="Choose a folder">
    <div class="modal-head"><span>Choose a folder</span><button class="link-btn" data-act="picker-close" aria-label="Close">✕</button></div>
    <div class="crumbs">${d.parent ? `<button class="btn small" data-act="picker-go" data-path="${esc(d.parent)}" title="Up one level">↑</button>` : ''}${crumbs}</div>
    <div class="dir-list">${d.entries.length ? d.entries.map((e) => `
      <button class="dir ${e.isRepo ? 'repo' : ''}" data-act="picker-go" data-path="${esc(e.path)}">
        ${e.isRepo ? REPO_ICON : FOLDER_ICON}<span class="dir-name">${esc(e.name)}</span>${e.isRepo ? '<span class="chip open">git repo</span>' : ''}${added.includes(e.path) ? '<span class="chip">added</span>' : ''}
      </button>`).join('') : '<div class="file-note">No folders here.</div>'}</div>
    <div class="modal-foot">
      <div class="verdict">${verdict}</div>
      <div class="actions">
        <label class="toggle small"><input type="checkbox" data-act="picker-hidden" ${S.picker.hidden ? 'checked' : ''}> Show hidden</label>
        <span style="flex:1"></span>
        <button class="btn" data-act="picker-close">Cancel</button>
        <button class="btn primary" data-act="picker-add" ${already || (!d.isRepo && !d.repoChildren) ? 'disabled' : ''}>${already ? 'Already added' : d.isRepo ? 'Add this repo' : 'Add this folder'}</button>
      </div>
    </div>
  </div>`;
  el.querySelector('.dir-list').scrollTop = 0;
}

// ---------- loading ----------

async function loadView({ quiet = false } = {}) {
  const wt = curWt();
  if (!wt) { renderMain(); return; }
  const seq = ++S.seq;
  const mode = S.mode || (wt.review.reviewedAt ? 'since' : 'full');
  try {
    const [diff, cm] = await Promise.all([
      api('GET', `/api/worktrees/${wt.id}/diff?mode=${mode}`),
      api('GET', `/api/worktrees/${wt.id}/comments`),
    ]);
    if (seq !== S.seq) return;
    S.mode = diff.mode;
    let files, groups = null;
    if (diff.mode === 'commits') {
      groups = diff.commits.map((c) => ({ ...c, files: parseDiff(c.diff).map((f) => ({ ...f, commit: c.sha, commitN: c.n, uid: `${c.sha}~${f.path}` })) }));
      const unc = parseDiff(diff.uncommitted).map((f) => ({ ...f, commit: null, commitN: 0, uncommitted: true, uid: `u~${f.path}` }));
      if (unc.length) groups.push({ n: 0, sha: null, subject: 'Uncommitted changes', files: unc });
      files = groups.flatMap((g) => g.files);
    } else {
      // Order files by the first commit that touched them; uncommitted-only files last.
      const first = (p) => { const ns = (diff.fileCommits?.[p] || []).filter((n) => n > 0); return ns.length ? Math.min(...ns) : Infinity; };
      files = parseDiff(diff.diff).map((f) => ({ ...f, commit: null, uid: f.path }))
        .map((f, i) => ({ f, i, k: first(f.path) })).sort((a, b) => a.k - b.k || a.i - b.i).map((x) => x.f);
    }
    S.view = { wtId: wt.id, diff, files, groups, comments: cm.comments, reviews: cm.reviews, commentSig: wt.comments.sig, crSig: wt.coderabbit?.sig, blame: S.view?.wtId === wt.id && S.view.blame?.fingerprint === diff.fingerprint ? S.view.blame : null };
    if (diff.mode !== 'commits' && !S.view.blame && diff.commits.length) {
      api('GET', `/api/worktrees/${wt.id}/blame`).then((b) => {
        if (seq !== S.seq || b.fingerprint !== S.view.diff.fingerprint) return;
        S.view.blame = b;
        renderMain();
      }, () => {});
    }
    await loadCodeRabbit();
    if (seq !== S.seq) return;
    S.stale = false;
    renderMain();
  } catch (e) {
    if (seq !== S.seq) return;
    if (!quiet) $('#main').innerHTML = `<div class="page">${headerHtml(wt)}<div class="callout warn">${esc(e.message)}</div></div>`;
  }
}

async function reloadComments() {
  if (!S.view) return;
  const cm = await api('GET', `/api/worktrees/${S.view.wtId}/comments`);
  S.view.comments = cm.comments;
  S.view.reviews = cm.reviews;
  renderMain();
}

function select(id) {
  if (S.selId === id) return;
  S.selId = id;
  S.mode = null;
  S.view = null;
  S.toggled.clear();
  S.forceRender.clear();
  S.editors.clear();
  S.shutCommits.clear();
  S.openBodies.clear();
  S.hl = null;
  $('#main').scrollTop = 0;
  renderSidebar();
  renderMain();
  loadView();
}

function onHash() {
  const id = location.hash.replace(/^#\/?/, '') || null;
  if (id === 'settings' || id === 'welcome' || id === 'cleanup') {
    S.page = id;
    S.selId = null;
    S.view = null;
    S.setupSig = S.st ? setupSig(S.st) : null;
    $('#main').scrollTop = 0;
    renderSidebar();
    renderMain();
    loadIntegrations();
    return;
  }
  S.page = null;
  if (id) select(id); else { S.selId = null; renderSidebar(); renderMain(); }
}

// ---------- live updates ----------

function maybeNotify(st) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  for (const s of st.sessions) {
    const prev = S.prevStatus.get(s.sessionId);
    if (prev === 'busy' && s.status === 'idle') {
      const wts = st.worktrees.filter((w) => w.review.needsReview && w.sessions.some((x) => x.sessionId === s.sessionId));
      if (!wts.length) continue;
      const n = new Notification(`${s.name} finished`, { body: `Ready to review: ${wts.map((w) => w.branch || w.path).join(', ')}`, tag: s.sessionId });
      n.onclick = () => { window.focus(); location.hash = `#/${wts[0].id}`; };
    }
  }
  S.prevStatus = new Map(st.sessions.map((s) => [s.sessionId, s.status]));
  for (const w of st.worktrees) {
    const prev = S.prevCr?.get(w.id);
    if (prev === 'running' && w.coderabbit && w.coderabbit.status !== 'running') {
      const n = new Notification(`CodeRabbit finished on ${w.branch || 'a worktree'}`, { body: w.coderabbit.total ? `${w.coderabbit.total} finding${w.coderabbit.total === 1 ? '' : 's'}` : 'No findings', tag: `cr-${w.id}` });
      n.onclick = () => { window.focus(); location.hash = `#/${w.id}`; };
    }
  }
  S.prevCr = new Map(st.worktrees.map((w) => [w.id, w.coderabbit?.status]));
}

function onState(st) {
  const first = !S.st;
  maybeNotify(st);
  S.st = st;
  renderSidebar();
  const wt = curWt();
  if (first) {
    if (!st.onboardedAt && location.hash !== '#/welcome') location.hash = '#/welcome';
    else onHash();
    return;
  }
  if (S.page) {
    const sig = setupSig(st);
    if (sig === S.setupSig) return;
    const loginFinished = S.setupSig && JSON.parse(S.setupSig)[0]?.running && !st.coderabbitLogin?.running;
    S.setupSig = sig;
    if (loginFinished) loadIntegrations(true);
    else if (S.page === 'cleanup' || !document.activeElement?.matches('input, select, textarea')) renderMain();
    return;
  }
  if (!wt || !S.view || S.view.wtId !== wt.id) { renderMain(); return; }
  if (wt.fingerprint !== S.view.diff.fingerprint) {
    const typing = [...S.editors.entries()].some(([k, val]) => k !== 'summary' && val !== undefined);
    if (typing) { S.stale = true; renderMain(); } else loadView({ quiet: true });
  } else if ((wt.coderabbit?.sig || null) !== (S.view.crSig || null)) {
    const was = S.view.cr?.status;
    S.view.crSig = wt.coderabbit?.sig;
    loadCodeRabbit().then(() => {
      if (was === 'running' && S.view.cr && S.view.cr.status !== 'running') {
        const n = S.view.cr.findings.length;
        toast(S.view.cr.status === 'done' ? `CodeRabbit finished: ${n ? `${n} finding${n === 1 ? '' : 's'}` : 'no findings'}` : 'CodeRabbit review stopped', S.view.cr.status === 'failed');
      }
      if (wt.comments.sig !== S.view.commentSig) { S.view.commentSig = wt.comments.sig; reloadComments(); } else renderMain();
    });
  } else if (wt.comments.sig !== S.view.commentSig) {
    S.view.commentSig = wt.comments.sig;
    reloadComments();
  } else if (headerSig(wt) !== S.view.headerSig && !document.activeElement?.matches('textarea, input')) {
    renderMain();
  }
}

function onLiveMessage(msg) {
  if (msg.type === 'state') {
    const st = JSON.parse(msg.data);
    $('#conn').textContent = `live · v${st.version}`;
    $('#conn').className = 'brand-sub';
    onState(st);
  } else if (msg.type === 'error') {
    $('#conn').textContent = 'server not running — retrying';
    $('#conn').className = 'brand-sub down';
  }
}

function connect() {
  if ('SharedWorker' in window) {
    try {
      const worker = new SharedWorker('/sse-worker.js', { name: 'worktree-review-live' });
      worker.port.onmessage = (e) => onLiveMessage(e.data);
      worker.port.start();
      window.addEventListener('pagehide', () => worker.port.postMessage('close'));
      return;
    } catch {}
  }
  const es = new EventSource('/api/events');
  es.addEventListener('state', (e) => onLiveMessage({ type: 'state', data: e.data }));
  es.onerror = () => onLiveMessage({ type: 'error' });
}

// ---------- actions ----------

function lineTextFor(key) {
  const { commit, file, side, line } = parseKey(key);
  const f = S.view.files.find((x) => x.path === file && sameCommit(x.commit, commit));
  for (const h of f?.hunks || []) for (const l of h.lines) {
    if ((side === 'old' ? l.o : l.n) === Number(line) && (side === 'old') === (l.t === 'del')) return l.text;
  }
  return '';
}

async function saveEditor(ek) {
  const text = (S.editors.get(ek) || '').trim();
  if (!text) return;
  const [kind, rest] = [ek.slice(0, ek.indexOf(':')), ek.slice(ek.indexOf(':') + 1)];
  if (kind === 'new') {
    const { commit, file, side, line } = parseKey(rest);
    const c = commit && S.view.diff.commits.find((x) => x.sha === commit);
    await api('POST', '/api/comments', { wtId: S.view.wtId, file, side, line, lineText: lineTextFor(rest), body: text, commit: commit || undefined, commitSubject: c?.subject });
  } else if (kind === 'edit') {
    await api('PATCH', `/api/comments/${rest}`, { body: text });
  } else if (kind === 'reply') {
    await api('POST', `/api/comments/${rest}/reply`, { body: text, author: 'you' });
  }
  S.editors.delete(ek);
  await reloadComments();
}

const actions = {
  'new-comment': (el) => {
    const ek = `new:${el.dataset.k}`;
    if (!S.editors.has(ek)) S.editors.set(ek, '');
    S.focusEk = ek;
    renderMain();
  },
  'cancel-editor': (el) => { S.editors.delete(el.dataset.ek); renderMain(); },
  'save-editor': (el) => saveEditor(el.dataset.ek),
  edit: (el) => {
    const c = S.view.comments.find((x) => x.id === el.dataset.id);
    S.editors.set(`edit:${c.id}`, c.body);
    S.focusEk = `edit:${c.id}`;
    renderMain();
  },
  reply: (el) => { S.editors.set(`reply:${el.dataset.id}`, ''); S.focusEk = `reply:${el.dataset.id}`; renderMain(); },
  delete: async (el) => { await api('DELETE', `/api/comments/${el.dataset.id}`); await reloadComments(); },
  resolve: async (el) => { await api('POST', `/api/comments/${el.dataset.id}/resolve`, { author: 'you' }); await reloadComments(); },
  reopen: async (el) => { await api('POST', `/api/comments/${el.dataset.id}/reopen`); await reloadComments(); },
  'toggle-file': (el) => {
    const f = S.view.files.find((x) => x.uid === el.dataset.file);
    S.toggled.set(f.uid, !isCollapsed(f));
    renderMain();
  },
  'collapse-all': () => {
    if (S.view.diff.mode === 'commits') for (const g of S.view.groups) S.shutCommits.add(g.n);
    else for (const f of S.view.files) S.toggled.set(f.uid, true);
    renderMain();
  },
  'expand-all': () => { S.shutCommits.clear(); renderMain(); },
  'toggle-body': (el) => {
    const n = Number(el.dataset.n);
    if (S.openBodies.has(n)) S.openBodies.delete(n); else S.openBodies.add(n);
    renderMain();
  },
  'toggle-commit': (el) => {
    const n = Number(el.dataset.n);
    if (S.shutCommits.has(n)) S.shutCommits.delete(n); else S.shutCommits.add(n);
    renderMain();
    // Keep the header you clicked in view; collapsing can pull the page up under the cursor.
    document.getElementById(`cg-${n}`)?.scrollIntoView({ block: 'nearest' });
  },
  'hl-commit': (el, e) => {
    e.preventDefault();
    const n = el.dataset.n === '' ? null : Number(el.dataset.n);
    S.hl = S.hl === n ? null : n;
    if (S.hl !== null) for (const f of S.view.files) if ((S.view.diff.fileCommits?.[f.path] || []).includes(S.hl)) S.toggled.set(f.uid, false);
    renderMain();
  },
  'view-commit': (el, e) => {
    e.preventDefault();
    S.scrollTo = `cg-${el.dataset.n}`;
    S.shutCommits.delete(Number(el.dataset.n));
    if (S.view.diff.mode === 'commits') { renderMain(); return; }
    S.mode = 'commits';
    S.hl = null;
    loadView();
  },
  'force-render': (el) => { S.forceRender.add(el.dataset.file); renderMain(); },
  viewed: async (el) => {
    const f = S.view.files.find((x) => x.path === el.dataset.file);
    const on = el.checked;
    await api('POST', `/api/worktrees/${S.view.wtId}/viewed`, { file: f.path, hash: f.hash, viewed: on });
    if (on) S.view.diff.viewed[f.path] = f.hash; else delete S.view.diff.viewed[f.path];
    S.toggled.delete(f.uid);
    renderMain();
  },
  jump: (el, e) => {
    e.preventDefault();
    const f = S.view.files.find((x) => x.path === el.dataset.file && !x.commit);
    if (isCollapsed(f)) { S.toggled.set(f.uid, false); renderMain(); }
    document.getElementById(`f-${fnv(f.uid)}`)?.scrollIntoView({ block: 'start' });
  },
  mode: (el, e) => { e.preventDefault(); S.mode = el.dataset.mode; S.hl = null; loadView(); },
  refresh: () => loadView(),
  'mark-reviewed': async () => {
    await api('POST', `/api/worktrees/${S.view.wtId}/reviewed`, { tree: S.view.diff.tree, fingerprint: S.view.diff.fingerprint });
    toast('Marked as reviewed. Next time you\'ll see only what changed.');
    S.mode = 'since';
    loadView();
  },
  'set-base': async () => {
    try { await api('POST', `/api/worktrees/${S.selId}/base`, { base: $('#base').value }); S.view = null; loadView(); } catch (e) { toast(e.message, true); }
  },
  'reset-base': async () => { await api('POST', `/api/worktrees/${S.selId}/base`, { base: '' }); S.view = null; loadView(); },
  'copy-path': () => copy(curWt().path, 'Path copied'),
  'copy-prompt': async () => { const { text } = await api('GET', `/api/worktrees/${S.selId}/prompt`); copy(text, 'Review copied as a prompt'); },
  submit: async () => {
    const wt = curWt();
    await api('POST', `/api/worktrees/${wt.id}/submit`, { summary: S.summaries[wt.id] || '', targetSession: S.summaries[`${wt.id}:target`] || null });
    S.summaries[wt.id] = '';
    S.editors.delete('summary');
    toast(wt.sessions.length ? 'Sent. Claude gets it at the end of its current turn.' : 'Queued for the next Claude session that works here.');
    await reloadComments();
  },
  'cancel-review': async (el) => { await api('POST', `/api/reviews/${el.dataset.id}/cancel`); await reloadComments(); },
  remove: async () => {
    const wt = curWt();
    const msg = wt.cleanup?.kind === 'idle'
      ? `Remove this worktree?\n\nIts folder is deleted. ${wt.branch ? `The branch ${wt.branch} is kept, so its commits are safe` : 'Its commit is on a branch, so nothing is lost'}, and you can restore it from Cleaned up.`
      : 'Remove this worktree? Its branch is deleted too if it matches the merged PR.';
    if (!confirm(msg)) return;
    delete S.removeErrors[S.selId];
    await api('POST', `/api/worktrees/${S.selId}/remove`);
  },
  'remove-anyway': async () => {
    const wt = curWt();
    const cs = wt.cleanup;
    const lost = cs.dirty ? cs.dirty.files.map((f) => `  • ${f.file}`).join('\n') + (cs.dirty.count > cs.dirty.files.length ? `\n  …and ${cs.dirty.count - cs.dirty.files.length} more` : '') : '';
    const comments = wt.comments.draft + wt.comments.waiting;
    const msg = [`Remove ${wt.branch || 'this worktree'} anyway?`, '',
      lost ? `These uncommitted changes will be lost:\n${lost}` : '',
      comments ? `${comments} unsent review comment${comments === 1 ? '' : 's'} will stay in the dashboard's history but can't be delivered.` : '',
      '', wt.branch ? `The branch ${wt.branch} is kept, so its commits are safe.` : ''].filter((l, i, a) => l || a[i - 1]).join('\n');
    if (!confirm(msg)) return;
    delete S.removeErrors[wt.id];
    await api('POST', `/api/worktrees/${wt.id}/remove`, { force: true });
  },
  'cleanup-safe': async () => {
    const n = S.st.worktrees.filter((w) => w.cleanup?.kind === 'merged' && w.cleanup.eligible).length;
    if (!confirm(`Remove ${n} merged worktree${n === 1 ? '' : 's'} that are clean and not in use? This runs in the background.`)) return;
    await api('POST', '/api/cleanup/safe');
  },
  'clean-pick': (el) => { S.cleanSel.set(el.dataset.id, el.checked); renderMain(); },
  'clean-all': (el) => { for (const w of cleanupGroups().ready) S.cleanSel.set(w.id, el.dataset.on === '1'); renderMain(); },
  'clean-run': async () => {
    const ids = cleanupGroups().ready.filter((w) => cleanPicked(w)).map((w) => w.id);
    if (!ids.length) return;
    const merged = ids.filter((id) => S.st.worktrees.find((w) => w.id === id)?.cleanup.branchSafe).length;
    const msg = `Remove ${ids.length} worktree${ids.length === 1 ? '' : 's'}?\n\nTheir folders are deleted. ${merged ? `${merged} merged branch${merged === 1 ? ' is' : 'es are'} deleted too, because everything on ${merged === 1 ? 'it is' : 'them is'} in the merged PR. ` : ''}Every other branch is kept, and each removal can be restored from Cleaned up. This runs in the background.`;
    if (!confirm(msg)) return;
    await api('POST', '/api/cleanup', { ids });
    for (const id of ids) S.cleanSel.delete(id);
  },
  'job-dismiss': (el) => api('POST', `/api/jobs/${el.dataset.id}/dismiss`),
  'job-details': (el) => {
    const j = S.st.jobs.find((x) => x.id === el.dataset.id);
    if (!j) return;
    const verb = j.kind === 'repair' ? 'Repaired' : 'Removed';
    showResult({ title: j.title, ok: j.ok, okLabel: verb, failed: j.failed, failedLabel: j.kind === 'repair' ? "Couldn't repair" : "Couldn't remove" });
  },
  repair: async () => {
    const r = await api('POST', `/api/worktrees/${S.selId}/repair`);
    if (r.failed.length) { S.removeErrors[S.selId] = `Repair didn't work: ${r.failed[0].error}`; renderMain(); }
    else { delete S.removeErrors[S.selId]; toast('Link repaired'); S.view = null; loadView(); }
  },
  'repair-all': async () => {
    const n = S.st.worktrees.filter((w) => w.error?.kind === 'broken-link').length;
    if (!confirm(`Repair the links for ${n} worktree${n === 1 ? '' : 's'}? This runs "git worktree repair" in each repository, which rewrites the link files for all of that repository's worktrees; your code isn't touched.`)) return;
    toast(`Repairing ${n} worktree link${n === 1 ? '' : 's'}…`);
    const r = await api('POST', '/api/repair');
    if (!r.failed.length) { toast(`Repaired ${r.fixed.length} worktree link${r.fixed.length === 1 ? '' : 's'}`); return; }
    showResult({ title: 'Repair worktree links', ok: r.fixed, okLabel: 'Repaired', failed: r.failed, failedLabel: "Couldn't repair",
      note: r.fixed.length ? 'Repaired worktrees are checked again now. Clean, merged ones become removable within a few seconds.' : '' });
  },
  'close-result': () => closeResult(),
  'result-open': (el) => { closeResult(); location.hash = `#/${el.dataset.id}`; },
  'auto-cleanup': async (el) => { await api('POST', '/api/config', { autoCleanup: el.checked }); },
  'toggle-older': () => { S.showOlder = !S.showOlder; renderSidebar(); },
  'toggle-cleaned': () => { S.showCleaned = !S.showCleaned; renderSidebar(); },
  'cr-run': async () => {
    const r = await api('POST', `/api/worktrees/${S.selId}/coderabbit`);
    S.view.cr = r;
    indexFindings();
    toast('CodeRabbit started. This usually takes a few minutes.');
    renderMain();
  },
  'cr-cancel': async () => {
    if (!confirm('Cancel this CodeRabbit review? Its progress is thrown away.')) return;
    await api('POST', `/api/worktrees/${S.selId}/coderabbit/cancel`);
  },
  'cr-send': async (el) => { await api('POST', `/api/findings/${el.dataset.id}/send`); await loadCodeRabbit(); await reloadComments(); },
  'cr-dismiss': async (el) => { await api('POST', `/api/findings/${el.dataset.id}/dismiss`); await loadCodeRabbit(); renderMain(); },
  'cr-restore': async (el) => { await api('POST', `/api/findings/${el.dataset.id}/restore`); await loadCodeRabbit(); renderMain(); },
  'cr-send-all': async () => {
    const { sent } = await api('POST', `/api/worktrees/${S.selId}/coderabbit/send-all`);
    toast(`Added ${sent} finding${sent === 1 ? '' : 's'} to your review as drafts`);
    await loadCodeRabbit();
    await reloadComments();
  },
  'cr-jump': (el, e) => {
    e.preventDefault();
    const f = S.view.files.find((x) => x.path === el.dataset.file && !x.commit);
    if (!f) { toast('That file isn\'t in this diff view'); return; }
    if (isCollapsed(f)) { S.toggled.set(f.uid, false); renderMain(); }
    const row = document.querySelector(`tr.line[data-k="${CSS.escape(keyOf(f.path, 'new', el.dataset.line))}"]`);
    (row || document.getElementById(`f-${fnv(f.path)}`))?.scrollIntoView({ block: 'center' });
  },
  recheck: () => { S.integ = null; renderMain(); return loadIntegrations(true); },
  'copy-text': (el) => copy(el.dataset.text),
  'cr-login': async () => { await api('POST', '/api/integrations/coderabbit/login'); },
  'cr-logout': async () => {
    if (!confirm('Sign out of the CodeRabbit CLI on this machine?')) return;
    S.integ = await api('POST', '/api/integrations/coderabbit/logout');
    renderMain();
  },
  'open-picker': () => openPicker(S.picker?.data?.path || '~'),
  'picker-go': (el) => openPicker(el.dataset.path),
  'picker-hidden': (el) => { S.picker.hidden = el.checked; openPicker(S.picker.data.path); },
  'picker-close': () => closePicker(),
  'picker-add': async () => {
    const d = S.picker.data;
    const key = d.isRepo ? 'extraRepos' : 'roots';
    if (S.st.config[key].map(expandHome).includes(d.path)) { toast('Already added'); return; }
    await saveConfig({ [key]: [...S.st.config[key], d.path] });
    closePicker();
  },
  'remove-folder': (el) => saveConfig({ [el.dataset.key]: S.st.config[el.dataset.key].filter((p) => p !== el.dataset.path) }),
  'enable-notifications': () => Notification.requestPermission().then(() => { $('#notify').hidden = true; renderMain(); }),
  'rerun-setup': async () => { await api('POST', '/api/onboarding', { done: false }); location.hash = '#/welcome'; },
  'finish-setup': async () => {
    await api('POST', '/api/onboarding', { done: true });
    const first = grouped(S.st.worktrees).working[0] || S.st.worktrees[0];
    location.hash = first ? `#/${first.id}` : '#/';
  },
  'copy-restore': (el) => {
    const c = S.st.cleaned[Number(el.dataset.i)];
    const cmd = !c.branch ? `git -C ${c.repoRoot} worktree add --detach ${c.path} ${c.sha}`
      : c.branchDeleted ? `git -C ${c.repoRoot} worktree add -b ${c.branch} ${c.path} ${c.sha}`
      : `git -C ${c.repoRoot} worktree add ${c.path} ${c.branch}`;
    copy(cmd, 'Restore command copied');
  },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.tagName === 'SELECT' || (el.type === 'checkbox' && e.type === 'click' && !['viewed', 'auto-cleanup', 'picker-hidden', 'clean-pick'].includes(el.dataset.act))) return;
  const fn = actions[el.dataset.act];
  if (!fn) return;
  if (el.tagName === 'A') e.preventDefault();
  Promise.resolve(fn(el, e)).catch((err) => toast(err.message, true));
});

document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.act === 'target') S.summaries[`${S.selId}:target`] = el.value;
  if (el.dataset.cfg) {
    const key = el.dataset.cfg;
    const value = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
    saveConfig({ [key]: value });
  }
});

document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.id === 'filter') { S.filter = el.value; renderSidebar(); return; }
  if (!el.dataset.ek) return;
  if (el.dataset.ek === 'summary') {
    S.summaries[S.selId] = el.value;
    const btn = $('[data-act="submit"]');
    if (btn) btn.disabled = !el.value.trim() && !S.view.comments.some((c) => c.status === 'draft');
  } else S.editors.set(el.dataset.ek, el.value);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('#picker')) { closePicker(); return; }
  if (e.key === 'Escape' && $('#result') && !$('#result').dataset.busy) { closeResult(); return; }
  const el = e.target;
  if (!el.dataset?.ek || el.dataset.ek === 'summary') return;
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveEditor(el.dataset.ek).catch((err) => toast(err.message, true)); }
  if (e.key === 'Escape') { S.editors.delete(el.dataset.ek); renderMain(); }
});

window.addEventListener('hashchange', onHash);

const nb = $('#notify');
if ('Notification' in window && Notification.permission === 'default') {
  nb.hidden = false;
  nb.onclick = () => Notification.requestPermission().then(() => { nb.hidden = true; });
}

connect();
