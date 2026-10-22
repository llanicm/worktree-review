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
      ${wt.dirty ? `<span class="chip" title="Uncommitted changes">${wt.dirty} uncommitted</span>` : ''}
    </div>
  </a>`;
}

function renderSidebar() {
  if (!S.st) return;
  const f = S.filter.toLowerCase();
  const list = S.st.worktrees.filter((w) => !f || (w.branch || '').toLowerCase().includes(f) || w.path.toLowerCase().includes(f));
  const g = grouped(list);
  const safe = g.merged.filter((w) => w.cleanup?.eligible).length;
  const parts = [];
  const section = (title, items, opts = {}) => {
    if (!items.length && !opts.always) return;
    parts.push(`<div class="group-head"><span>${title} <span class="count">${items.length}</span></span>${opts.right || ''}</div>`);
    if (opts.tools) parts.push(opts.tools);
    if (!opts.hidden) parts.push(items.map((w) => wtItem(w, opts.showNew)).join(''));
  };
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
  if (S.st.cleaned.length) {
    parts.push(`<div class="group-head"><span>Cleaned up <span class="count">${S.st.cleaned.length}</span></span>
      <button class="link-btn" data-act="toggle-cleaned">${S.showCleaned ? 'hide' : 'show'}</button></div>`);
    if (S.showCleaned) {
      parts.push(`<div class="cleaned">${S.st.cleaned.map((c, i) => `<div class="item">
        <div><strong>${esc(c.branch)}</strong> · <a href="${esc(c.pr.url)}" target="_blank">#${c.pr.number}</a> · ${c.how === 'auto' ? 'auto' : 'by you'} ${ago(c.at)}</div>
        <div class="mono">${esc(shortPath(c.path))}</div>
        <button class="link-btn" data-act="copy-restore" data-i="${i}">Copy restore command</button>
      </div>`).join('')}</div>`);
    }
  }
  if (!S.st.worktrees.length) parts.push('<div class="group-tools">No worktrees yet. Repos show up here once Claude Code has worked in them.</div>');
  if (S.st.prError) parts.unshift(`<div class="group-tools">${md(S.st.prError)}</div>`);
  $('#list').innerHTML = parts.join('');

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
const keyOf = (file, side, line) => `${file}|${side}|${line}`;

function isCollapsed(f) {
  if (S.toggled.has(f.path)) return S.toggled.get(f.path);
  return S.view.diff.viewed[f.path] === f.hash || f.generated;
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
  const head = `<div class="file-head">
    <button class="caret" data-act="toggle-file" data-file="${esc(f.path)}" aria-label="Collapse">${collapsed ? '▸' : '▾'}</button>
    <span class="file-name" title="${esc(f.path)}">${name}</span>${tag}${gen}
    <span class="stat-add">+${f.add}</span><span class="stat-del">−${f.del}</span>
    ${f.status !== 'deleted' && wt && editorLink(wt.path) ? `<a class="file-tag" href="${esc(editorLink(`${wt.path}/${f.path}`, firstLine))}" title="Open in ${editorName()}">open</a>` : ''}
    <label class="viewed-box ${viewed ? 'on' : ''}"><input type="checkbox" data-act="viewed" data-file="${esc(f.path)}" ${viewed ? 'checked' : ''}> Viewed</label>
  </div>`;

  let body;
  const lang = langFor(f.path);
  const outdated = (S.view.comments || []).filter((c) => c.file === f.path && !used.has(c.id) && !byAnchor.has(keyOf(c.file, c.side, c.line)) && c.status !== 'resolved');
  if (collapsed) body = '';
  else if (f.binary) body = '<div class="file-note">Binary file</div>';
  else if (!f.hunks.length) body = `<div class="file-note">${f.status === 'renamed' ? 'Renamed without changes' : 'No content changes (mode change or empty file)'}</div>`;
  else if (f.lineCount > 2500 && !S.forceRender.has(f.path)) body = `<div class="file-note">Large diff (${f.lineCount} lines). <button class="link-btn" data-act="force-render" data-file="${esc(f.path)}">Load it</button></div>`;
  else {
    const rows = [];
    for (const h of f.hunks) {
      rows.push(`<tr class="hunk"><td colspan="3">${esc(h.header)}</td></tr>`);
      for (const l of h.lines) {
        const side = l.t === 'del' ? 'old' : 'new';
        const line = l.t === 'del' ? l.o : l.n;
        const k = keyOf(f.path, side, line);
        const sign = l.t === 'add' ? '+' : l.t === 'del' ? '−' : ' ';
        rows.push(`<tr class="line ${l.t}" data-k="${esc(k)}"><td class="num" data-act="new-comment" data-k="${esc(k)}">${l.o ?? ''}</td><td class="num" data-act="new-comment" data-k="${esc(k)}">${l.n ?? ''}</td><td class="code"><button class="add-c" data-act="new-comment" data-k="${esc(k)}" title="Comment on this line">+</button><span class="sign">${sign}</span>${hl(l.text, lang)}</td></tr>`);
        const threads = (byAnchor.get(k) || []);
        threads.forEach((c) => used.add(c.id));
        const ek = `new:${k}`;
        if (threads.length || S.editors.has(ek)) {
          rows.push(`<tr class="thread-row"><td colspan="3"><div class="threads">${threads.map(threadHtml).join('')}${S.editors.has(ek) ? editorHtml(ek, 'Add comment') : ''}</div></td></tr>`);
        }
      }
    }
    body = `<table class="diff"><colgroup><col class="num"><col class="num"><col></colgroup>${rows.join('')}</table>`;
  }
  const out = outdated.length && !collapsed
    ? `<div class="outdated"><div class="outdated-label">Comments on lines that are no longer in this diff</div><div class="threads">${outdated.map((c) => { used.add(c.id); return `<div class="mono">line ${c.line}: ${esc(c.lineText || '')}</div>${threadHtml(c)}`; }).join('')}</div></div>` : '';
  return `<section class="file ${collapsed ? 'collapsed' : ''}" id="f-${fnv(f.path)}">${head}<div class="file-body">${out}${body}</div></section>`;
}

function renderMain() {
  const main = $('#main');
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
    const k = keyOf(c.file, c.side, c.line);
    if (!byAnchor.has(k)) byAnchor.set(k, []);
    byAnchor.get(k).push(c);
  }
  const used = new Set();
  const filesHtml = v.files.map((f) => renderFile(f, byAnchor, used)).join('');
  const orphan = v.comments.filter((c) => !used.has(c.id) && c.status !== 'resolved' && !v.files.some((f) => f.path === c.file));
  const viewedCount = v.files.filter((f) => v.diff.viewed[f.path] === f.hash).length;
  const since = v.diff.mode === 'since';

  v.headerSig = headerSig(wt);
  const scroll = main.scrollTop;
  main.innerHTML = `<div class="page">
    ${headerHtml(wt)}
    ${commitsHtml(v.diff.commits)}
    <div class="toolbar">
      <div class="actions">
        <div class="seg">
          <button data-act="mode" data-mode="full" class="${since ? '' : 'on'}">All changes</button>
          <button data-act="mode" data-mode="since" class="${since ? 'on' : ''}" ${v.diff.sinceAvailable ? '' : 'disabled title="Mark as reviewed first"'}>Since last review${v.diff.reviewedAt ? ` (${ago(v.diff.reviewedAt)})` : ''}</button>
        </div>
        <span class="progress">${viewedCount} / ${v.files.length} files viewed</span>
      </div>
      <div class="actions">
        ${S.stale ? '<span class="banner">New changes landed. <button class="btn small" data-act="refresh">Refresh</button></span>' : ''}
        <button class="btn" data-act="collapse-all">Collapse all</button>
        <button class="btn" data-act="mark-reviewed" title="Remember this exact state so you can see only what changes next">Mark as reviewed</button>
      </div>
    </div>
    ${v.diff.truncated ? '<div class="callout warn">This diff is very large and was cut off.</div>' : ''}
    ${orphan.length ? `<div class="panel"><div class="panel-head">Comments on files not in this view</div><div class="panel-body threads">${orphan.map((c) => `<div class="mono">${esc(c.file)}:${c.line}</div>${threadHtml(c)}`).join('')}</div></div>` : ''}
    ${v.files.length ? filesSummaryHtml(v) + filesHtml : `<div class="callout">${since ? 'Nothing has changed since your last review.' : `No changes against <code>${esc(v.diff.baseRef)}</code>.`}</div>`}
  </div>
  ${reviewBarHtml(wt)}`;
  main.scrollTop = scroll;

  if (S.focusEk) {
    const ta = main.querySelector(`textarea[data-ek="${CSS.escape(S.focusEk)}"]`);
    if (ta) { ta.focus(); ta.selectionStart = ta.selectionEnd = ta.value.length; }
    S.focusEk = null;
  }
}

const headerSig = (wt) => JSON.stringify([wt.sessions, wt.pr, wt.cleanup, wt.ahead, wt.dirty, wt.baseRef, wt.baseError, S.st.sessions.length, S.st.config]);

function headerHtml(wt) {
  const name = wt.branch || `detached @ ${wt.head?.slice(0, 10)}`;
  const pr = wt.pr ? ` <a class="pr-no" href="${esc(wt.pr.url)}" target="_blank">#${wt.pr.number}</a>` : '';
  const cs = wt.cleanup;
  let cleanup = '';
  if (cs) {
    cleanup = cs.eligible
      ? `<div class="callout merged"><strong>PR merged.</strong> This worktree is clean and nothing is using it. ${cs.auto && S.st.config.autoCleanup ? 'It will be removed automatically in a moment.' : 'It was merged before auto-cleanup was set up, so it waits for you.'}
          <div class="actions" style="margin-top:8px"><button class="btn danger" data-act="remove">Remove worktree</button></div></div>`
      : `<div class="callout warn"><strong>PR merged, but it isn't safe to remove this worktree automatically:</strong><ul>${cs.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></div>`;
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
    ${wt.baseError ? `<div class="callout warn">${esc(wt.baseError)}. Set a different base above.</div>` : ''}
    ${cleanup}`;
}

function commitsHtml(commits) {
  if (!commits.length) return '';
  return `<details class="panel" ${commits.length <= 6 ? 'open' : ''}><summary class="panel-head" style="cursor:pointer">${commits.length} commit${commits.length === 1 ? '' : 's'}</summary>
    <div class="panel-body">${commits.map((c) => `<div class="commit"><span class="mono">${c.sha.slice(0, 8)}</span><span class="subject">${esc(c.subject)}</span><span class="when">${ago(c.time)}</span></div>`).join('')}</div></details>`;
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
    S.view = { wtId: wt.id, diff, files: parseDiff(diff.diff), comments: cm.comments, reviews: cm.reviews, commentSig: wt.comments.sig };
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
  $('#main').scrollTop = 0;
  renderSidebar();
  renderMain();
  loadView();
}

function onHash() {
  const id = location.hash.replace(/^#\/?/, '') || null;
  if (id) select(id);
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
}

function onState(st) {
  const first = !S.st;
  maybeNotify(st);
  S.st = st;
  renderSidebar();
  const wt = curWt();
  if (first) { onHash(); return; }
  if (!wt || !S.view || S.view.wtId !== wt.id) { renderMain(); return; }
  if (wt.fingerprint !== S.view.diff.fingerprint) {
    const typing = [...S.editors.entries()].some(([k, val]) => k !== 'summary' && val !== undefined);
    if (typing) { S.stale = true; renderMain(); } else loadView({ quiet: true });
  } else if (wt.comments.sig !== S.view.commentSig) {
    S.view.commentSig = wt.comments.sig;
    reloadComments();
  } else if (headerSig(wt) !== S.view.headerSig && !document.activeElement?.matches('textarea, input')) {
    renderMain();
  }
}

function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('state', (e) => {
    $('#conn').textContent = `live · v${JSON.parse(e.data).version}`;
    $('#conn').className = 'brand-sub';
    onState(JSON.parse(e.data));
  });
  es.onerror = () => {
    $('#conn').textContent = 'server not running — retrying';
    $('#conn').className = 'brand-sub down';
  };
}

// ---------- actions ----------

function lineTextFor(key) {
  const [file, side, line] = key.split('|');
  const f = S.view.files.find((x) => x.path === file);
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
    const [file, side, line] = rest.split('|');
    await api('POST', '/api/comments', { wtId: S.view.wtId, file, side, line: Number(line), lineText: lineTextFor(rest), body: text });
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
    const f = S.view.files.find((x) => x.path === el.dataset.file);
    S.toggled.set(f.path, !isCollapsed(f));
    renderMain();
  },
  'collapse-all': () => { for (const f of S.view.files) S.toggled.set(f.path, true); renderMain(); },
  'force-render': (el) => { S.forceRender.add(el.dataset.file); renderMain(); },
  viewed: async (el) => {
    const f = S.view.files.find((x) => x.path === el.dataset.file);
    const on = el.checked;
    await api('POST', `/api/worktrees/${S.view.wtId}/viewed`, { file: f.path, hash: f.hash, viewed: on });
    if (on) S.view.diff.viewed[f.path] = f.hash; else delete S.view.diff.viewed[f.path];
    S.toggled.delete(f.path);
    renderMain();
  },
  jump: (el, e) => {
    e.preventDefault();
    const f = S.view.files.find((x) => x.path === el.dataset.file);
    if (isCollapsed(f)) { S.toggled.set(f.path, false); renderMain(); }
    document.getElementById(`f-${fnv(f.path)}`)?.scrollIntoView({ block: 'start' });
  },
  mode: (el) => { S.mode = el.dataset.mode; loadView(); },
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
    if (!confirm('Remove this worktree? Its branch is deleted too if it matches the merged PR.')) return;
    await api('POST', `/api/worktrees/${S.selId}/remove`);
    toast('Worktree removed');
  },
  'cleanup-safe': async () => {
    const n = S.st.worktrees.filter((w) => w.cleanup?.eligible).length;
    if (!confirm(`Remove ${n} merged worktree${n === 1 ? '' : 's'} that are clean and not in use?`)) return;
    const r = await api('POST', '/api/cleanup/safe');
    toast(`Removed ${r.removed.length}${r.failed.length ? `, ${r.failed.length} skipped` : ''}`);
  },
  'auto-cleanup': async (el) => { await api('POST', '/api/config', { autoCleanup: el.checked }); },
  'toggle-older': () => { S.showOlder = !S.showOlder; renderSidebar(); },
  'toggle-cleaned': () => { S.showCleaned = !S.showCleaned; renderSidebar(); },
  'copy-restore': (el) => {
    const c = S.st.cleaned[Number(el.dataset.i)];
    const cmd = c.branchDeleted
      ? `git -C ${c.repoRoot} worktree add -b ${c.branch} ${c.path} ${c.sha}`
      : `git -C ${c.repoRoot} worktree add ${c.path} ${c.branch}`;
    copy(cmd, 'Restore command copied');
  },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.tagName === 'SELECT' || (el.type === 'checkbox' && e.type === 'click' && el.dataset.act !== 'viewed' && el.dataset.act !== 'auto-cleanup')) return;
  const fn = actions[el.dataset.act];
  if (!fn) return;
  if (el.tagName === 'A') e.preventDefault();
  Promise.resolve(fn(el, e)).catch((err) => toast(err.message, true));
});

document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.act === 'target') S.summaries[`${S.selId}:target`] = el.value;
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
