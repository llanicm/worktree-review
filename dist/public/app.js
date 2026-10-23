// Generated from src/ by build.mjs. Edit the TypeScript source, not this file.

// src/web/state.ts
var S = {
  st: null,
  selId: null,
  mode: null,
  view: null,
  seq: 0,
  editors: /* @__PURE__ */ new Map(),
  focusEk: null,
  toggled: /* @__PURE__ */ new Map(),
  forceRender: /* @__PURE__ */ new Set(),
  filter: "",
  showOlder: false,
  showCleaned: false,
  stale: false,
  summaries: {},
  prevStatus: /* @__PURE__ */ new Map(),
  page: null,
  cleanSel: /* @__PURE__ */ new Map(),
  shutCommits: /* @__PURE__ */ new Set(),
  bases: /* @__PURE__ */ new Map(),
  basesLoading: /* @__PURE__ */ new Set(),
  baseOther: null,
  blameOn: /* @__PURE__ */ new Set(),
  fileBlame: /* @__PURE__ */ new Map(),
  openBodies: /* @__PURE__ */ new Set(),
  removeErrors: {},
  seenJobs: /* @__PURE__ */ new Set(),
  integ: null,
  setupSig: null
};
var $ = (sel, root = document) => root.querySelector(sel);
function need(sel) {
  const el = $(sel);
  if (!el) throw new Error(`Missing element ${sel}`);
  return el;
}
function st() {
  if (!S.st) throw new Error("No server state yet");
  return S.st;
}
function view() {
  if (!S.view) throw new Error("No diff loaded");
  return S.view;
}
var curWt = () => S.st?.worktrees.find((w) => w.id === S.selId);
var errMsg = (e) => e instanceof Error ? e.message : String(e);
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json", "x-wtr": "1" },
    body: body ? JSON.stringify(body) : void 0
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json;
}

// src/web/util.ts
var ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
var esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c] ?? c);
var toastTimer;
function toast(msg, isErr = false) {
  const el = need("#toast");
  el.textContent = msg;
  el.className = "toast" + (isErr ? " err" : "");
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, isErr ? 6e3 : 2500);
}
function ago(ms) {
  if (!ms) return "";
  const s = Math.max(0, (Date.now() - ms) / 1e3);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ms).toLocaleDateString();
}
var elapsed = (ms) => {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1e3));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
var elapsedBetween = (a, b) => {
  const s = Math.max(0, Math.round(((b || Date.now()) - a) / 1e3));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};
var tilde = (p) => S.st?.home && p.startsWith(S.st.home) ? "~" + p.slice(S.st.home.length) : p;
var expandHome = (p) => p.startsWith("~") && S.st?.home ? S.st.home + p.slice(1) : p;
var EDITORS = { vscode: "vscode", cursor: "cursor", windsurf: "windsurf", zed: "zed" };
var EDITOR_NAMES = { vscode: "VS Code", cursor: "Cursor", windsurf: "Windsurf", zed: "Zed" };
var editorName = () => EDITOR_NAMES[S.st?.config.editor ?? ""] || null;
function editorLink(p, line) {
  const scheme = EDITORS[S.st?.config.editor ?? ""];
  if (!scheme) return null;
  return scheme === "zed" ? `zed://file${p}${line ? `:${line}` : ""}` : `${scheme}://file${p}${line ? `:${line}` : ""}`;
}
var shortPath = (p) => {
  const parts = tilde(p).split("/");
  return parts.length > 3 ? "…/" + parts.slice(-2).join("/") : tilde(p);
};
var fnv = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
};
var copy = (text, label = "Copied") => navigator.clipboard.writeText(text).then(() => toast(label), () => toast("Copy failed", true));
function md(text) {
  return esc(text).replace(/```([\s\S]*?)```/g, (_, c) => `<code>${c.trim()}</code>`).replace(/`([^`\n]+)`/g, "<code>$1</code>").replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
}

// src/web/diff.ts
function startHunk(line) {
  const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/) || [];
  return { header: line, oldNo: Number(m[1] || 0), newNo: Number(m[2] || 0), lines: [] };
}
function parseDiff(text) {
  const files = [];
  let f = null, h = null;
  for (const l of text.split("\n")) {
    if (l.startsWith("diff --git ")) {
      const m = l.match(/^diff --git a\/(.*) b\/(.*)$/);
      f = { raw: [l], hunks: [], oldPath: m?.[1] ?? "", newPath: m?.[2] ?? "", status: "modified", binary: false, add: 0, del: 0 };
      files.push(f);
      h = null;
      continue;
    }
    if (!f) continue;
    f.raw.push(l);
    if (!h) {
      if (l.startsWith("new file mode")) f.status = "added";
      else if (l.startsWith("deleted file mode")) f.status = "deleted";
      else if (l.startsWith("rename from ")) {
        f.oldPath = l.slice(12);
        f.status = "renamed";
      } else if (l.startsWith("rename to ")) f.newPath = l.slice(10);
      else if (l.startsWith("Binary files")) f.binary = true;
      else if (l.startsWith("--- ") && l !== "--- /dev/null") f.oldPath = l.slice(4).replace(/^a\//, "");
      else if (l.startsWith("+++ ") && l !== "+++ /dev/null") f.newPath = l.slice(4).replace(/^b\//, "");
      else if (l.startsWith("@@")) {
        h = startHunk(l);
        f.hunks.push(h);
      }
      continue;
    }
    if (l.startsWith("@@")) {
      h = startHunk(l);
      f.hunks.push(h);
      continue;
    }
    const c = l[0];
    if (c === "+") {
      h.lines.push({ t: "add", text: l.slice(1), n: h.newNo++ });
      f.add++;
    } else if (c === "-") {
      h.lines.push({ t: "del", text: l.slice(1), o: h.oldNo++ });
      f.del++;
    } else if (c === " ") h.lines.push({ t: "ctx", text: l.slice(1), o: h.oldNo++, n: h.newNo++ });
  }
  return files.map((file) => {
    const path = file.status === "deleted" ? file.oldPath : file.newPath;
    return {
      ...file,
      path,
      hash: fnv(file.raw.join("\n")),
      lineCount: file.hunks.reduce((n, hk) => n + hk.lines.length, 0),
      generated: /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Cargo\.lock|go\.sum)$|__generated__|\.generated\.|\.snap$|\.min\.(js|css)$/.test(path)
    };
  });
}
var LANG = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  sql: "pgsql",
  py: "python",
  go: "go",
  rs: "rust",
  rb: "ruby",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yml: "yaml",
  yaml: "yaml",
  md: "markdown",
  css: "css",
  scss: "scss",
  html: "xml",
  xml: "xml",
  svg: "xml",
  graphql: "graphql",
  gql: "graphql",
  tf: "ini",
  toml: "ini",
  dockerfile: "dockerfile",
  c: "c",
  h: "c",
  cpp: "cpp",
  cs: "csharp",
  php: "php"
};
function langFor(p) {
  const base = (p.split("/").pop() ?? "").toLowerCase();
  if (base === "dockerfile") return "dockerfile";
  const lang = LANG[base.split(".").pop() ?? ""];
  const lib = window.hljs;
  if (!lib || !lang) return null;
  if (lib.getLanguage(lang)) return lang;
  if (lang === "pgsql" && lib.getLanguage("sql")) return "sql";
  return null;
}
function hl(text, lang) {
  const lib = window.hljs;
  if (!lang || !lib || text.length > 1e3) return esc(text);
  try {
    return lib.highlight(text, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return esc(text);
  }
}
var keyOf = (file, side, line, commit) => `${commit ? `${commit}~` : ""}${file}|${side}|${line}`;
function parseKey(k) {
  const m = k.match(/^([0-9a-f]{40})~(.*)$/);
  const rest = m ? m[2] ?? "" : k;
  const i = rest.lastIndexOf("|"), j = rest.lastIndexOf("|", i - 1);
  return { commit: m ? m[1] ?? null : null, file: rest.slice(0, j), side: rest.slice(j + 1, i), line: Number(rest.slice(i + 1)) };
}
var sameCommit = (a, b) => (a || null) === (b || null);

// src/web/code-review.ts
var SEV_ORDER = ["critical", "major", "minor", "trivial", "info", "none"];
var REVIEWERS = ["coderabbit", "claude"];
var NAMES = { coderabbit: "CodeRabbit", claude: "Claude" };
var EFFORTS = [["low", "Low (quickest)"], ["medium", "Medium"], ["high", "High"], ["xhigh", "Extra high"], ["max", "Max (most thorough)"]];
var ready = (k) => k === "coderabbit" ? st().coderabbitReady : st().claudeReady;
var reviewsSig = (wt) => REVIEWERS.map((k) => wt.codeReviews[k]?.sig || "").join();
var findingsOf = (v) => REVIEWERS.flatMap((k) => v.codeReviews?.[k]?.findings || []);
function reviewPick(wt) {
  const idle = REVIEWERS.filter((k) => ready(k) && wt.codeReviews[k]?.status !== "running");
  const p = S.reviewPick;
  const reviewer = p && idle.includes(p.reviewer) ? p.reviewer : idle[0] ?? "claude";
  return { reviewer, effort: p?.effort || st().config.reviewEffort };
}
function runningHtml(wt, k) {
  const r = wt.codeReviews[k];
  if (r?.status !== "running") return "";
  return `<span class="cr-running ${k}"><span class="dot busy"></span>${NAMES[k]} reviewing <span class="cr-elapsed" data-start="${r.startedAt}">${elapsed(r.startedAt)}</span></span>
    <button class="btn small" data-act="review-cancel" data-reviewer="${k}">Cancel</button>`;
}
function menuHtml(wt, idle) {
  const pick = reviewPick(wt);
  const choice = (k, note) => `<label class="choice"><input type="radio" name="reviewer" data-review="reviewer" value="${k}" ${pick.reviewer === k ? "checked" : ""}>
    <span><strong>${NAMES[k]}</strong><br><span class="muted small">${note}</span></span></label>`;
  return `<div class="review-menu" role="dialog" aria-label="Run code review">
    ${idle.length > 1 ? `<div class="review-menu-title">Who should review?</div>
      ${choice("coderabbit", "The CodeRabbit CLI. Uses one of your hourly CodeRabbit reviews.")}
      ${choice("claude", "Claude Code's built-in /code-review, run on this machine.")}` : ""}
    ${pick.reviewer === "claude" ? `<label class="setting row"><span>Effort</span>
      <select data-review="effort">${EFFORTS.map(([v, l]) => `<option value="${v}" ${pick.effort === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <p class="muted small">Higher effort looks harder, takes longer and uses more of your Claude usage. The default is in Settings.</p>` : ""}
    <div class="actions"><button class="btn small" data-act="review-menu">Cancel</button><button class="btn small primary" data-act="review-start">Start review</button></div>
  </div>`;
}
function reviewButtonHtml(wt) {
  const running = REVIEWERS.map((k) => runningHtml(wt, k)).join("");
  if (!REVIEWERS.some(ready)) return '<a class="btn" href="#/settings" title="Connect CodeRabbit or Claude in Settings">Set up code review</a>';
  const idle = REVIEWERS.filter((k) => ready(k) && wt.codeReviews[k]?.status !== "running");
  if (!idle.length) return running;
  const button = idle.length === 1 && idle[0] === "coderabbit" ? '<button class="btn" data-act="review-start" title="Ask CodeRabbit to review these changes (uses one of your hourly CodeRabbit reviews)">Run code review</button>' : `<button class="btn" data-act="review-menu" aria-expanded="${S.reviewMenu === wt.id}">Run code review</button>`;
  return `${running}<span class="review-run">${button}${S.reviewMenu === wt.id ? menuHtml(wt, idle) : ""}</span>`;
}
function findingHtml(f, inline = false) {
  const loc = f.file ? `${f.file}${f.startLine ? `:${f.startLine}${f.endLine && f.endLine !== f.startLine ? `–${f.endLine}` : ""}` : ""}` : "";
  const acts = f.status === "open" ? `<button class="btn small primary" data-act="cr-send" data-id="${f.id}">Send to Claude</button><button class="btn small" data-act="cr-dismiss" data-id="${f.id}">Dismiss</button>` : f.status === "sent" ? '<span class="muted small">Added to your review as a draft</span>' : `<span class="muted small">Dismissed</span><button class="link-btn" data-act="cr-restore" data-id="${f.id}">undo</button>`;
  const detail = [
    f.comment && f.comment !== f.title ? `<div class="msg-body">${md(f.comment)}</div>` : "",
    f.suggestions ? `<details><summary>Suggested change</summary><pre class="suggestion">${esc(f.suggestions)}</pre></details>` : "",
    f.codegen && f.codegen !== f.comment ? `<details><summary>Fix guidance for agents</summary><div class="msg-body">${md(f.codegen)}</div></details>` : ""
  ].join("");
  return `<div class="thread cr-finding ${f.source} ${f.status}">
    <div class="msg"><div class="msg-head"><strong class="cr-name">${NAMES[f.source]}</strong><span class="sev ${esc(f.severity)}">${esc(f.severity)}</span>
      ${!inline && loc ? `<a href="#" class="mono" data-act="cr-jump" data-file="${esc(f.file)}" data-line="${f.endLine || f.startLine || ""}">${esc(loc)}</a>` : ""}</div>
      ${f.title ? `<div class="cr-title">${md(f.title)}</div>` : ""}
      ${f.status === "open" || !inline ? detail : ""}</div>
    <div class="thread-actions">${acts}</div></div>`;
}
function panelHtml(wt, r) {
  const name = NAMES[r.reviewer];
  const findings = [...r.findings].sort((a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity));
  const open = findings.filter((f) => f.status === "open");
  const stale = r.status !== "running" && r.fingerprint && r.fingerprint !== wt.fingerprint;
  let head, body = "";
  if (r.status === "running") {
    head = `${name} is reviewing against <code>${esc(r.baseRef)}</code>`;
    body = r.reviewer === "coderabbit" ? `<p class="muted">Reviews usually take 2–6 minutes and can take 15 or more. You can leave this page; findings appear here and inline as they arrive.</p>` : `<p class="muted">${r.message ? `${esc(r.message)}…` : "Starting…"}</p><p class="muted">Findings appear here and inline when it's done. You can leave this page.</p>`;
  } else if (r.status === "done") {
    head = `${name} · ${findings.length ? `${open.length} open of ${findings.length} finding${findings.length === 1 ? "" : "s"}` : "no findings"}`;
    if (!findings.length) body = `<p class="muted">${r.reviewedFiles.length ? `Reviewed ${r.reviewedFiles.length} file${r.reviewedFiles.length === 1 ? "" : "s"} and found` : "Found"} nothing to flag.</p>`;
  } else {
    head = `${name} review ${r.status === "cancelled" ? "cancelled" : "failed"}`;
    body = `<p class="error">${esc(r.error || "Something went wrong.")}</p>`;
  }
  const facts = [r.status === "running" ? `started ${ago(r.startedAt)}` : ago(r.finishedAt || r.startedAt)];
  if (r.usage) facts.push(`${r.usage.remaining} of ${r.usage.limit} reviews left this hour`);
  if (r.effort) facts.push(`${r.effort} effort`);
  if (r.costUsd) facts.push(`<span title="As Claude Code reports it. On a Claude plan this counts toward your usage rather than being billed.">$${r.costUsd.toFixed(2)}</span>`);
  return `<div class="panel cr-panel ${r.reviewer}">
    <div class="panel-head"><span>${head}</span><span class="actions"><span class="muted small">${facts.join(" · ")}</span>${open.length > 1 ? `<button class="btn small" data-act="cr-send-all" data-reviewer="${r.reviewer}">Send all to Claude</button>` : ""}</span></div>
    <div class="panel-body">
      ${stale ? `<div class="callout warn small">The code has changed since this review. Line numbers may be off; run ${name} again for a fresh look.</div>` : ""}
      ${body}
      <div class="threads cr-list">${findings.map((f) => findingHtml(f)).join("")}</div>
    </div></div>`;
}
function reviewPanelsHtml(wt) {
  const panels = REVIEWERS.map((k) => S.view?.codeReviews?.[k]).filter((r) => !!r).map((r) => panelHtml(wt, r));
  return panels.length ? `<div class="cr-panels">${panels.join("")}</div>` : "";
}
function indexFindings() {
  const v = view();
  const byAnchor2 = /* @__PURE__ */ new Map();
  v.crByAnchor = byAnchor2;
  for (const f of findingsOf(v)) {
    if (f.status !== "open" || !f.file) continue;
    const k = keyOf(f.file, "new", f.endLine || f.startLine);
    const here = byAnchor2.get(k);
    if (here) here.push(f);
    else byAnchor2.set(k, [f]);
  }
}
async function loadCodeReviews() {
  if (!S.view) return;
  try {
    const { reviews } = await api("GET", `/api/worktrees/${S.view.wtId}/code-reviews`);
    S.view.codeReviews = reviews;
    indexFindings();
  } catch {
  }
}

// src/web/file.ts
var commitClass = (n) => n === 0 ? "cu" : `c${(n - 1) % 8 + 1}`;
var commitLabel = (n) => n === 0 ? "uncommitted" : `#${n}`;
function commitOfLine(file, n) {
  const b = S.view?.blame?.lines?.[file];
  if (!b) return void 0;
  for (const [a, z, c] of b) if (n !== void 0 && n >= a && n <= z) return c;
  return void 0;
}
function commitByN(n) {
  return S.view?.diff.commits.find((c) => c.n === n);
}
var fileCommitsOf = (path) => {
  const d = S.view?.diff;
  return (d && "fileCommits" in d ? d.fileCommits?.[path] : void 0) || [];
};
function isCollapsed(f) {
  const t = S.toggled.get(f.uid);
  if (t !== void 0) return t;
  return !f.commit && view().diff.viewed[f.path] === f.hash || f.generated;
}
function statusLabel(c) {
  if (c.status === "draft") return "Draft";
  if (c.status === "pending") return "Submitted · waiting for a session";
  if (c.status === "delivered") return `Sent to ${c.deliveredTo?.name || "Claude"}`;
  if (c.status === "resolved") return "Resolved";
  return c.status;
}
function editorHtml(ek, label) {
  return `<div class="editor"><textarea data-ek="${esc(ek)}" placeholder="Leave a comment">${esc(S.editors.get(ek) || "")}</textarea>
    <div class="actions"><span class="hint">⌘↵ to save · Esc to cancel</span>
      <button class="btn small" data-act="cancel-editor" data-ek="${esc(ek)}">Cancel</button>
      <button class="btn small primary" data-act="save-editor" data-ek="${esc(ek)}">${label}</button></div></div>`;
}
function threadHtml(c) {
  const editing = S.editors.has(`edit:${c.id}`);
  const replying = S.editors.has(`reply:${c.id}`);
  const msgs = [`<div class="msg"><div class="msg-head"><strong>You</strong><span class="status ${c.status}">${esc(statusLabel(c))}</span><span>${ago(c.createdAt)}</span></div>
    ${editing ? editorHtml(`edit:${c.id}`, "Update") : `<div class="msg-body">${md(c.body)}</div>`}</div>`];
  for (const r of c.replies || []) {
    msgs.push(`<div class="msg"><div class="msg-head"><strong>${r.author === "you" ? "You" : "Claude"}</strong><span>${ago(r.at)}</span></div><div class="msg-body">${md(r.body)}</div></div>`);
  }
  const acts = [];
  if (c.status === "draft" && !editing) acts.push(`<button class="btn small" data-act="edit" data-id="${c.id}">Edit</button>`, `<button class="btn small danger" data-act="delete" data-id="${c.id}">Delete</button>`);
  if (c.status === "delivered" || c.status === "pending") acts.push(`<button class="btn small" data-act="resolve" data-id="${c.id}">Resolve</button>`);
  if (c.status === "resolved") acts.push(`<button class="btn small" data-act="reopen" data-id="${c.id}">Reopen</button>`);
  if (c.status !== "draft" && !replying) acts.push(`<button class="btn small" data-act="reply" data-id="${c.id}">Reply</button>`);
  if (replying) msgs.push(`<div class="msg">${editorHtml(`reply:${c.id}`, "Reply")}<div class="msg-head">A reply turns this back into a draft to send to Claude with your next review.</div></div>`);
  return `<div class="thread ${c.status}">${msgs.join("")}${acts.length ? `<div class="thread-actions">${acts.join("")}</div>` : ""}</div>`;
}
function bodyKind(f) {
  if (isCollapsed(f)) return "collapsed";
  if (f.binary) return "binary";
  if (!f.hunks.length) return "empty";
  if (f.lineCount > 2500 && !S.forceRender.has(f.uid)) return "large";
  return "rows";
}
function shownKeys(f) {
  const shown = /* @__PURE__ */ new Set();
  for (const h of f.hunks) for (const l of h.lines) shown.add(l.t === "del" ? keyOf(f.path, "old", l.o, f.commit) : keyOf(f.path, "new", l.n, f.commit));
  return shown;
}
function placedCommentIds(v) {
  const placed = /* @__PURE__ */ new Set();
  const byFile = /* @__PURE__ */ new Map();
  for (const c of v.comments) {
    if (c.status === "resolved") continue;
    const k = `${c.commit || ""}\0${c.file}`;
    const here = byFile.get(k);
    if (here) here.push(c);
    else byFile.set(k, [c]);
  }
  if (!byFile.size) return placed;
  const files = v.diff.mode === "commits" ? (v.groups ?? []).filter((g) => !S.shutCommits.has(g.n)).flatMap((g) => g.files) : v.files;
  for (const f of files) {
    const mine = byFile.get(`${f.commit || ""}\0${f.path}`);
    if (!mine) continue;
    const rows = bodyKind(f) === "rows";
    const shown = rows ? null : shownKeys(f);
    for (const c of mine) if (!shown || !shown.has(keyOf(c.file, c.side, c.line, c.commit))) placed.add(c.id);
  }
  return placed;
}
function renderFile(f, byAnchor2) {
  const v = view();
  const kind = bodyKind(f);
  const collapsed = kind === "collapsed";
  const viewed = v.diff.viewed[f.path] === f.hash;
  const wt = curWt();
  const name = f.status === "renamed" && f.oldPath !== f.newPath ? `<span class="from">${esc(f.oldPath)} →</span> ${esc(f.newPath)}` : esc(f.path);
  const tag = f.status !== "modified" ? `<span class="file-tag">${f.status}</span>` : "";
  const gen = f.generated ? '<span class="file-tag">generated</span>' : "";
  const firstLine = f.hunks[0]?.lines.find((l) => l.n)?.n || 1;
  let body;
  const lang = langFor(f.path);
  const shown = shownKeys(f);
  const mine = (v.comments || []).filter((c) => c.file === f.path && sameCommit(c.commit, f.commit) && c.status !== "resolved");
  const outsideComments = mine.filter((c) => !shown.has(keyOf(c.file, c.side, c.line, c.commit)));
  const fileFindings = f.commit ? [] : findingsOf(v).filter((x) => x.file === f.path && x.status === "open");
  const outsideFindings = fileFindings.filter((x) => !shown.has(keyOf(x.file, "new", x.endLine || x.startLine)));
  const nOpen = mine.length + fileFindings.length;
  const touched = !f.commit ? fileCommitsOf(f.path) : [];
  const commitChips = touched.length && v.diff.commits.length ? touched.map((n) => `<span class="cchip ${commitClass(n)}" title="${esc(n ? `${commitByN(n)?.sha.slice(0, 8)} ${commitByN(n)?.subject || ""}` : "Not committed yet")}">${commitLabel(n)}</span>`).join("") : "";
  const head = `<div class="file-head">
    <button class="caret" data-act="toggle-file" data-file="${esc(f.uid)}" aria-label="Collapse">${collapsed ? "▸" : "▾"}</button>
    ${f.commitN !== void 0 && f.commit !== null || f.uncommitted ? `<span class="cchip fill ${commitClass(f.commitN ?? 0)}" title="${esc(f.uncommitted ? "Uncommitted changes" : `Commit #${f.commitN}`)}">${f.uncommitted ? "±" : `#${f.commitN}`}</span>` : ""}
    <span class="file-name" title="${esc(f.path)}">${name}</span>${tag}${gen}${commitChips}
    <span class="stat-add">+${f.add}</span><span class="stat-del">−${f.del}</span>
    ${collapsed && nOpen ? `<span class="chip comments" title="Expand to see them">${nOpen} comment${nOpen === 1 ? "" : "s"}</span>` : ""}
    ${f.status !== "deleted" && wt && editorLink(wt.path) ? `<a class="file-tag" href="${esc(editorLink(`${wt.path}/${f.path}`, firstLine))}" title="Open in ${editorName()}">open</a>` : ""}
    ${blameButtonHtml(f, collapsed)}
    ${f.commit ? "" : `<label class="viewed-box ${viewed ? "on" : ""}"><input type="checkbox" data-act="viewed" data-file="${esc(f.path)}" ${viewed ? "checked" : ""}> Viewed</label>`}
  </div>`;
  if (kind === "collapsed") body = "";
  else if (kind === "binary") body = '<div class="file-note">Binary file</div>';
  else if (kind === "empty") body = `<div class="file-note">${f.status === "renamed" ? "Renamed without changes" : "No content changes (mode change or empty file)"}</div>`;
  else if (kind === "large") body = `<div class="file-note">Large diff (${f.lineCount} lines). <button class="link-btn" data-act="force-render" data-file="${esc(f.uid)}">Load it</button></div>`;
  else if (lazyPlaceholder(f, mine.length + fileFindings.length > 0 || [...S.editors.keys()].some((k) => k.startsWith(`new:${f.commit ? `${f.commit}~` : ""}${f.path}|`)))) {
    body = lazyPlaceholderHtml(f);
  } else body = rowsHtml(f, byAnchor2);
  const snippet = (line, text) => `<div class="outside-line"><span class="outside-no">${line ?? ""}</span><code>${text ? hl(text, lang) : '<span class="muted">(line not available)</span>'}</code></div>`;
  const outsideItems = [
    ...outsideFindings.map((x) => ({ line: x.startLine, html: snippet(x.startLine, x.snippet) + findingHtml(x, true) })),
    ...outsideComments.map((c) => ({ line: c.line, html: snippet(c.line, c.lineText) + threadHtml(c) }))
  ].sort((a, b) => (a.line || 0) - (b.line || 0));
  const out = outsideItems.length && !collapsed ? `<div class="outdated"><div class="outdated-label">Not on a changed line, so shown here</div><div class="threads">${outsideItems.map((i) => i.html).join("")}</div></div>` : "";
  return `<section class="file ${collapsed ? "collapsed" : ""}" id="f-${fnv(f.uid)}">${head}<div class="file-body">${out}${body}</div></section>`;
}
function rowsHtml(f, byAnchor2) {
  const v = view();
  const lang = langFor(f.path);
  const rows = [];
  const fb = fileBlameOf(f);
  const span = fb ? 4 : 3;
  let lastSha = null;
  for (const h of f.hunks) {
    rows.push(`<tr class="hunk"><td colspan="${span}">${esc(h.header)}</td></tr>`);
    lastSha = null;
    for (const l of h.lines) {
      const side = l.t === "del" ? "old" : "new";
      const line = l.t === "del" ? l.o : l.n;
      const k = keyOf(f.path, side, line, f.commit);
      const sign = l.t === "add" ? "+" : l.t === "del" ? "−" : " ";
      const cn = !f.commit && l.t === "add" ? commitOfLine(f.path, l.n) : void 0;
      const cAttr = cn !== void 0 ? ` data-c="${cn}"` : "";
      const cBar = cn !== void 0 ? cbarHtml(cn) : "";
      let blameCell = "";
      if (fb) {
        const sha = l.t === "del" ? null : shaAt(fb, l.n);
        blameCell = blameCellHtml(fb, sha, sha !== lastSha);
        lastSha = sha;
      }
      rows.push(`<tr class="line ${l.t}" data-k="${esc(k)}"${cAttr}>${blameCell}<td class="num" data-act="new-comment" data-k="${esc(k)}">${l.o ?? ""}</td><td class="num" data-act="new-comment" data-k="${esc(k)}">${l.n ?? ""}</td><td class="code">${cBar}<button class="add-c" data-act="new-comment" data-k="${esc(k)}" title="Comment on this line">+</button><span class="sign">${sign}</span>${hl(l.text, lang)}</td></tr>`);
      const crHere = side === "new" ? v.crByAnchor?.get(k) || [] : [];
      const threads = byAnchor2.get(k) || [];
      const ek = `new:${k}`;
      if (threads.length || crHere.length || S.editors.has(ek)) {
        rows.push(`<tr class="thread-row"><td colspan="${span}"><div class="threads">${crHere.map((f2) => findingHtml(f2, true)).join("")}${threads.map(threadHtml).join("")}${S.editors.has(ek) ? editorHtml(ek, "Add comment") : ""}</div></td></tr>`);
      }
    }
  }
  return `<table class="diff${fb ? " blamed" : ""}"><colgroup>${fb ? '<col class="blame">' : ""}<col class="num"><col class="num"><col></colgroup>${rows.join("")}</table>`;
}
function cbarHtml(cn) {
  return `<span class="cbar ${commitClass(cn)}" title="${esc(cn ? `#${cn} ${commitByN(cn)?.sha.slice(0, 8)} ${commitByN(cn)?.subject || ""}` : "Not committed yet")}"></span>`;
}
var UNCOMMITTED = "0".repeat(40);
var blameKey = (f) => `${view().diff.fingerprint}:${f.path}`;
function fileBlameOf(f) {
  if (f.commit || !S.blameOn.has(f.uid)) return void 0;
  return S.fileBlame.get(blameKey(f));
}
function blameButtonHtml(f, collapsed) {
  if (f.commit || collapsed || f.status === "deleted" || f.binary) return "";
  const on = S.blameOn.has(f.uid);
  return `<button class="file-tag blame-btn ${on ? "on" : ""}" data-act="blame-file" data-file="${esc(f.uid)}" aria-pressed="${on}" title="${on ? "Hide" : "Show"} who last changed each line">Blame</button>`;
}
function shaAt(fb, line) {
  if (line === void 0) return null;
  let lo = 0, hi = fb.runs.length - 1;
  while (lo <= hi) {
    const mid = lo + hi >> 1;
    const r = fb.runs[mid];
    if (!r) break;
    if (line < r[0]) hi = mid - 1;
    else if (line > r[1]) lo = mid + 1;
    else return r[2];
  }
  return null;
}
function blameCellHtml(fb, sha, first) {
  const c = sha ? fb.commits[sha] : void 0;
  if (!c) return '<td class="blame"></td>';
  const cls = c.n === null ? "old" : commitClass(c.n);
  const uncommitted = c.sha === UNCOMMITTED;
  const title = uncommitted ? "Not committed yet" : `${c.summary}
${c.author}, ${new Date(c.time).toLocaleString()}
${c.sha}`;
  const act = c.n ? ` data-act="hl-commit" data-n="${c.n}"` : "";
  const label = !first ? "" : uncommitted ? '<span class="b-who">Not committed yet</span>' : `${c.n ? `<span class="b-num">#${c.n}</span>` : ""}<span class="b-sha">${c.sha.slice(0, 7)}</span><span class="b-who">${esc(c.author)}</span><span class="b-when">${ago(c.time)}</span>`;
  return `<td class="blame ${cls}${first ? " start" : ""}" title="${esc(title)}"${act}>${label}</td>`;
}

// src/web/lazy.ts
var FIRST_LINES = 600;
var NEAR_PX = 1500;
var ROW_PX = 20;
var HUNK_PX = 28;
var CHAR_PX = 7.2;
var render = null;
var byAnchor = /* @__PURE__ */ new Map();
function beginRender(main, anchors) {
  byAnchor = anchors;
  const near = /* @__PURE__ */ new Set();
  const box = main.getBoundingClientRect();
  for (const el of main.querySelectorAll("section.file")) {
    const r = el.getBoundingClientRect();
    if (r.bottom > box.top - NEAR_PX && r.top < box.bottom + NEAR_PX) near.add(el.id);
  }
  const cols = Math.max(40, Math.floor((box.width - 48 - 2 * 52 - 22) / CHAR_PX));
  render = { budget: near.size ? 0 : FIRST_LINES, near, cols };
}
function endRender(main) {
  render = null;
  watch(main);
}
function lazyPlaceholder(f, hasThreads) {
  if (!render || hasThreads || render.near.has(`f-${fnv(f.uid)}`)) return false;
  if (render.budget > 0) {
    render.budget -= f.lineCount;
    return false;
  }
  return true;
}
function lazyPlaceholderHtml(f) {
  const cols = render?.cols ?? 120;
  let h = 0;
  for (const hunk of f.hunks) {
    h += HUNK_PX;
    for (const l of hunk.lines) h += ROW_PX * Math.max(1, Math.ceil(l.text.length / cols));
  }
  return `<div class="lazy-rows" data-lazy="${esc(f.uid)}" style="height:${h}px"></div>`;
}
var io = null;
var idleTimer = null;
function fileByUid(uid) {
  const v = S.view;
  if (!v) return void 0;
  return v.files.find((f) => f.uid === uid) ?? v.groups?.flatMap((g) => g.files).find((f) => f.uid === uid);
}
function fill(el) {
  const uid = el.getAttribute("data-lazy");
  const f = uid === null ? void 0 : fileByUid(uid);
  io?.unobserve(el);
  if (!f || !el.isConnected) return;
  el.outerHTML = rowsHtml(f, byAnchor);
}
function watch(main) {
  io?.disconnect();
  if (idleTimer !== null) clearTimeout(idleTimer);
  const pending = main.querySelectorAll("[data-lazy]");
  if (!pending.length) return;
  io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) fill(e.target);
  }, { root: main, rootMargin: `${NEAR_PX}px 0px` });
  for (const el of pending) io.observe(el);
  const slice = () => {
    const end = performance.now() + 8;
    let el = main.querySelector("[data-lazy]");
    while (el && performance.now() < end) {
      fill(el);
      el = main.querySelector("[data-lazy]");
    }
    idleTimer = el ? window.setTimeout(slice, 30) : null;
  };
  idleTimer = window.setTimeout(slice, 600);
}
function fillFile(uid) {
  const el = document.querySelector(`[data-lazy="${CSS.escape(uid)}"]`);
  if (el) fill(el);
}

// src/web/jobs.ts
function jobHtml(j) {
  const pct = j.total ? Math.round(j.done / j.total * 100) : 100;
  const running = j.status === "running";
  const verb = j.kind === "repair" ? "Repaired" : "Removed";
  const line = running ? `${j.current ? `${j.kind === "repair" ? "Repairing" : "Removing"} <strong>${esc(j.current.branch || tilde(j.current.path))}</strong>` : "Starting…"} · ${j.done + 1 > j.total ? j.total : j.done + 1} of ${j.total}` : `${verb} ${j.ok.length}${j.failed.length ? ` · <span class="bad">${j.failed.length} failed</span>` : ""}`;
  return `<div class="job ${running ? "running" : j.failed.length ? "failed" : "ok"}">
    <div class="job-top"><span class="job-title">${esc(j.title)}</span>
      <span class="muted small">${running ? `<span class="tick" data-start="${j.startedAt}">${elapsed(j.startedAt)}</span>` : elapsedBetween(j.startedAt, j.finishedAt)}</span></div>
    <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="${j.total}" aria-valuenow="${j.done}"><div class="fill" style="width:${running ? Math.max(pct, 4) : 100}%"></div></div>
    <div class="job-line">${line}</div>
    ${j.failed.slice(0, 3).map((f) => `<div class="job-fail"><button class="link-btn" data-act="result-open" data-id="${esc(f.id)}">${esc(f.branch || tilde(f.path))}</button>: ${esc(f.error)}</div>`).join("")}
    ${!running ? `<div class="actions">${j.failed.length > 3 || j.ok.length ? `<button class="link-btn" data-act="job-details" data-id="${j.id}">Details</button>` : ""}<span style="flex:1"></span><button class="link-btn" data-act="job-dismiss" data-id="${j.id}">Dismiss</button></div>` : ""}
  </div>`;
}
function renderJobs() {
  const el = $("#jobs");
  if (!el) return;
  const list = S.st?.jobs || [];
  el.innerHTML = list.map(jobHtml).join("");
  for (const j of list) {
    if (j.status !== "done" || S.seenJobs.has(j.id)) continue;
    S.seenJobs.add(j.id);
    for (const f of j.failed) S.removeErrors[f.id] = f.error;
    for (const o of j.ok) delete S.removeErrors[o.id];
    if (!j.failed.length) setTimeout(() => api("POST", `/api/jobs/${j.id}/dismiss`).catch(() => {
    }), 6e3);
    if (j.failed.length && S.selId && j.failed.some((f) => f.id === S.selId)) renderMain();
  }
}

// src/web/sidebar.ts
var inUse = (wt) => wt.sessions.length > 0 || wt.agents.length > 0;
function defaultWorktree(list) {
  const g = grouped(list);
  return [...g.working, ...g.recent].find((w) => w.review.needsReview) ?? g.working[0] ?? g.recent[0] ?? list.find((w) => !w.isMain) ?? list[0];
}
function grouped(list) {
  const recentMs = st().config.recentDays * 864e5;
  const g = { working: [], merged: [], recent: [], older: [] };
  for (const wt of list) {
    if (inUse(wt)) g.working.push(wt);
    else if (wt.pr?.state === "MERGED") g.merged.push(wt);
    else if (Date.now() - wt.lastActivity < recentMs) g.recent.push(wt);
    else g.older.push(wt);
  }
  for (const items of Object.values(g)) items.sort((a, b) => b.lastActivity - a.lastActivity);
  return g;
}
function prChip(pr) {
  if (!pr) return "";
  const cls = pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : pr.isDraft ? "draftpr" : "open";
  const label = pr.state === "OPEN" && pr.isDraft ? "draft" : pr.state.toLowerCase();
  return `<span class="chip ${cls}" title="${esc(pr.title)}">#${pr.number} ${label}</span>`;
}
function sessionChip(s) {
  return `<span class="chip" title="Claude session ${esc(s.name)} is ${esc(s.status)}"><span class="dot ${esc(s.status)}"></span>${esc(s.name)}</span>`;
}
function agentChip(a) {
  const what = a.description || a.agentType;
  return `<span class="chip agent" title="${esc(a.agentType)} subagent started by Claude session ${esc(a.parent.name)} (${esc(a.parent.status)})${a.description ? `: ${esc(a.description)}` : ""}"><span class="dot busy"></span><span class="agent-parent">${esc(a.parent.name)}</span><span class="agent-sep">›</span><span class="agent-what">${esc(what)}</span></span>`;
}
function reviewChip(wt) {
  const running = REVIEWERS.filter((k) => wt.codeReviews[k]?.status === "running");
  if (running.length) return `<span class="chip cr"><span class="dot busy"></span>${running.map((k) => NAMES[k]).join(", ")}</span>`;
  const open = REVIEWERS.reduce((n, k) => n + (wt.codeReviews[k]?.open || 0), 0);
  return open ? `<span class="chip cr">${open} finding${open === 1 ? "" : "s"}</span>` : "";
}
function wtItem(wt, showNew) {
  const name = wt.branch || `detached @ ${wt.head?.slice(0, 8) || "?"}`;
  const c = wt.comments;
  const nComments = c.draft + c.waiting + c.open;
  const stats = wt.stats && (wt.stats.add || wt.stats.del) ? `<span class="stat-add">+${wt.stats.add}</span><span class="stat-del">−${wt.stats.del}</span>` : "";
  return `<a class="wt ${S.selId === wt.id ? "sel" : ""}" href="#/${wt.id}" title="${esc(wt.path)}">
    <div class="wt-top">
      ${showNew && wt.review.needsReview ? '<span class="new-dot" title="Changed since you last reviewed"></span>' : ""}
      <span class="wt-branch">${esc(name)}</span>${stats}
    </div>
    <div class="wt-sub">
      <span class="wt-path">${esc(shortPath(wt.path))}</span><span>· ${ago(wt.lastActivity)}</span>
    </div>
    <div class="wt-sub">
      ${wt.sessions.map(sessionChip).join("")}${wt.agents.map(agentChip).join("")}${prChip(wt.pr)}
      ${nComments ? `<span class="chip comments">${nComments} comment${nComments === 1 ? "" : "s"}</span>` : ""}
      ${wt.busy ? '<span class="chip busy-chip"><span class="dot busy"></span>removing…</span>' : ""}
      ${wt.error ? `<span class="chip closed" title="${esc(wt.error.message)}">${wt.error.kind === "broken-link" ? "broken link" : "can't read"}</span>` : wt.dirtyKind === "lockfile-only" ? '<span class="chip" title="Only a lockfile changed">lockfile changed</span>' : wt.dirtyKind === "deleted-only" ? `<span class="chip" title="Tracked files missing from disk; nothing is lost">${wt.dirty} missing</span>` : wt.dirty ? `<span class="chip" title="Uncommitted changes">${wt.dirty} uncommitted</span>` : ""}
      ${reviewChip(wt)}
    </div>
  </a>`;
}
function renderSidebar() {
  if (!S.st) return;
  const f = S.filter.toLowerCase();
  const list = S.st.worktrees.filter((w) => !f || (w.branch || "").toLowerCase().includes(f) || w.path.toLowerCase().includes(f));
  const g = grouped(list);
  const safe = g.merged.filter((w) => w.cleanup?.kind === "merged" && w.cleanup.eligible).length;
  const idle = S.st.worktrees.filter((w) => w.cleanup && !inUse(w)).length;
  const parts = [];
  const section = (title, items, opts = {}) => {
    if (!items.length && !opts.always) return;
    parts.push(`<div class="group-head"><span>${title} <span class="count">${items.length}</span></span>${opts.right || ""}</div>`);
    if (opts.tools) parts.push(opts.tools);
    if (!opts.hidden) parts.push(items.map((w) => wtItem(w, opts.showNew)).join(""));
  };
  const broken = S.st.worktrees.filter((w) => w.error?.kind === "broken-link").length;
  if (broken) {
    parts.push(`<div class="side-alert"><strong>${broken} worktree${broken === 1 ? " has a" : "s have"} broken link${broken === 1 ? "" : "s"}</strong>
      to ${broken === 1 ? "its" : "their"} repository, so git can't read ${broken === 1 ? "it" : "them"}. This usually means the repository moved.
      <button class="btn small" data-act="repair-all">Repair ${broken === 1 ? "it" : `all ${broken}`}</button></div>`);
  }
  section("Claude is working", g.working, { showNew: true });
  section("Recent", g.recent, { showNew: true });
  section("PR merged", g.merged, {
    tools: `<div class="group-tools">
      <label class="toggle"><input type="checkbox" data-act="auto-cleanup" ${S.st.config.autoCleanup ? "checked" : ""}> Remove automatically when merged</label>
      ${safe ? `<button class="link-btn" data-act="cleanup-safe">Remove ${safe} safe now</button>` : ""}
    </div>`
  });
  section("Older", g.older, {
    hidden: !S.showOlder && !f,
    right: f ? "" : `<button class="link-btn" data-act="toggle-older">${S.showOlder ? "hide" : "show"}</button>`
  });
  if (idle && !f) {
    parts.push(`<div class="group-tools"><a class="link-btn" href="#/cleanup">Clean up worktrees no session is using (${idle})</a></div>`);
  }
  if (S.st.cleaned.length) {
    parts.push(`<div class="group-head"><span>Cleaned up <span class="count">${S.st.cleaned.length}</span></span>
      <button class="link-btn" data-act="toggle-cleaned">${S.showCleaned ? "hide" : "show"}</button></div>`);
    if (S.showCleaned) {
      parts.push(`<div class="cleaned">${S.st.cleaned.map((c, i) => `<div class="item">
        <div><strong>${esc(c.branch || `detached @ ${c.sha.slice(0, 8)}`)}</strong>${c.pr ? ` · <a href="${esc(c.pr.url)}" target="_blank">#${c.pr.number}</a>` : ""} · ${c.how === "auto" ? "auto" : c.how === "forced" ? "removed anyway" : "by you"} ${ago(c.at)}${c.reason === "idle" ? " · unmerged" : ""}</div>
        ${c.branchKept ? `<div>Branch ${esc(c.branchKept)}</div>` : ""}
        <div class="mono">${esc(shortPath(c.path))}</div>
        <button class="link-btn" data-act="copy-restore" data-i="${i}">Copy restore command</button>
      </div>`).join("")}</div>`);
    }
  }
  if (!S.st.worktrees.length) parts.push('<div class="group-tools">No worktrees yet. Repos show up here once Claude Code has worked in them.</div>');
  if (S.st.prError) parts.unshift(`<div class="group-tools">${md(S.st.prError)}</div>`);
  need("#list").innerHTML = parts.join("");
  renderJobs();
  const recentMs = S.st.config.recentDays * 864e5;
  const n = S.st.worktrees.filter((w) => w.review.needsReview && (inUse(w) || Date.now() - w.lastActivity < recentMs)).length;
  document.title = n ? `(${n}) Worktree Review` : "Worktree Review";
}

// src/web/cleanup.ts
var hasCleanup = (w) => !!w.cleanup;
function cleanupGroups() {
  const g = { ready: [], look: [], blocked: [] };
  for (const w of st().worktrees) {
    if (!hasCleanup(w) || inUse(w)) continue;
    const cs = w.cleanup;
    (cs.eligible && !w.busy ? g.ready : cs.forceable ? g.look : g.blocked).push(w);
  }
  for (const items of Object.values(g)) items.sort((a, b) => a.lastActivity - b.lastActivity);
  return g;
}
function cleanPicked(w) {
  const t = S.cleanSel.get(w.id);
  if (t !== void 0) return t;
  return w.cleanup.kind === "merged" || w.pr?.state === "CLOSED" || Date.now() - w.lastActivity > st().config.recentDays * 864e5;
}
function cleanRow(w, { pick = false, open = false } = {}) {
  const cs = w.cleanup;
  const name = w.branch || `detached @ ${w.head?.slice(0, 8) || "?"}`;
  const notes = [...pick ? [] : cs.reasons, ...cs.notes];
  return `<label class="clean-row ${pick ? "" : "static"}">
    ${pick ? `<input type="checkbox" data-act="clean-pick" data-id="${w.id}" ${cleanPicked(w) ? "checked" : ""}>` : ""}
    <div class="clean-main">
      <div><strong>${esc(name)}</strong> ${prChip(w.pr)} ${w.busy ? '<span class="chip busy-chip"><span class="dot busy"></span>removing…</span>' : ""}
        <span class="muted small">${esc(w.repoName)} · ${esc(shortPath(w.path))} · ${ago(w.lastActivity)}</span>
        ${open ? `<a class="link-btn" href="#/${w.id}">open</a>` : ""}</div>
      ${notes.length ? `<ul class="notes">${notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
    </div></label>`;
}
function cleanupPageHtml() {
  const state = st();
  const g = cleanupGroups();
  const picked = g.ready.filter(cleanPicked).length;
  const running = state.jobs.some((j) => j.kind === "cleanup" && j.status === "running");
  const busy = state.worktrees.filter((w) => w.cleanup && inUse(w)).length;
  const sec = (title, sub, items, opts) => items.length ? `<section class="clean-sec"><h2>${title} <span class="count">${items.length}</span>${opts.tools || ""}</h2>
      ${sub ? `<p class="muted small">${sub}</p>` : ""}${items.map((w) => cleanRow(w, opts)).join("")}</section>` : "";
  return `<div class="page setup clean-page">
    <h1>Clean up worktrees</h1>
    <p class="muted">Worktrees no Claude session is using${busy ? ` (${busy} in use ${busy === 1 ? "is" : "are"} left out)` : ""}. Removing one deletes its folder.
      Branches are kept, except a merged branch whose commits are all in its PR, and every removal can be restored from <em>Cleaned up</em> in the sidebar.</p>
    ${!g.ready.length && !g.look.length && !g.blocked.length ? '<div class="empty">Nothing to clean up.</div>' : ""}
    ${sec("Ready to remove", `Nothing uncommitted would be lost. Ones changed in the last ${state.config.recentDays} days start unticked.`, g.ready, {
    pick: true,
    tools: ` <span class="clean-tools"><button class="link-btn" data-act="clean-all" data-on="1">all</button> <button class="link-btn" data-act="clean-all" data-on="0">none</button></span>`
  })}
    ${sec("Need a look first", "Removing these would lose uncommitted changes or unsent comments. Open one to see the files and use <em>Remove anyway</em>.", g.look, { open: true })}
    ${sec("Can't be removed", "", g.blocked, { open: true })}
    ${g.ready.length ? `<div class="clean-foot"><button class="btn danger" data-act="clean-run" ${picked && !running ? "" : "disabled"}>Remove ${picked} worktree${picked === 1 ? "" : "s"}</button>
      ${running ? '<span class="muted small">A clean-up is running; see the sidebar.</span>' : ""}</div>` : ""}
  </div>`;
}

// src/web/setup.ts
var ICON_OK = '<span class="check ok" aria-label="Done">✓</span>';
var ICON_TODO = '<span class="check todo" aria-label="Needs attention">!</span>';
var ICON_OPT = '<span class="check opt" aria-label="Optional">–</span>';
var ICON_WAIT = '<span class="check wait" aria-label="Checking">…</span>';
async function loadIntegrations(refresh = false) {
  try {
    S.integ = await api("GET", `/api/integrations${refresh ? "?refresh=1" : ""}`);
  } catch (e) {
    toast(errMsg(e), true);
  }
  if (S.page) renderMain();
}
function stepHtml(icon, title, body, extra = "") {
  return `<section class="step"><div class="step-icon">${icon}</div><div class="step-main"><h2>${title}</h2>${body}${extra}</div></section>`;
}
var cmd = (c) => `<code class="cmd">${esc(c)}</code><button class="link-btn" data-act="copy-text" data-text="${esc(c)}">copy</button>`;
function foldersHtml() {
  const c = st().config;
  const row = (key, p) => `<div class="folder-row"><code title="${esc(expandHome(p))}">${esc(tilde(expandHome(p)))}</code><button class="link-btn" data-act="remove-folder" data-key="${key}" data-path="${esc(p)}">remove</button></div>`;
  return `<div class="folders">
    ${c.roots.map((p) => row("roots", p)).join("")}${c.extraRepos.map((p) => row("extraRepos", p)).join("")}
    <div class="folder-add">
      <button class="btn small" data-act="open-picker">Choose a folder…</button>
      <span class="muted small">A repo, or a folder of repos.</span>
    </div>
  </div>`;
}
var EFFORT_OPTIONS = [["low", "Low (quickest)"], ["medium", "Medium"], ["high", "High"], ["xhigh", "Extra high"], ["max", "Max (most thorough)"]];
var EDITOR_OPTIONS = [["vscode", "VS Code"], ["cursor", "Cursor"], ["windsurf", "Windsurf"], ["zed", "Zed"], ["none", "No editor links"]];
function setupHtml(mode) {
  const state = st();
  const I = S.integ;
  const c = state.config;
  const welcome = mode === "welcome";
  const steps = [];
  const nRepos = state.repos.length;
  steps.push(stepHtml(
    state.worktrees.length ? ICON_OK : ICON_TODO,
    "Your worktrees",
    `<p>${state.worktrees.length ? `Found <strong>${state.worktrees.length} worktree${state.worktrees.length === 1 ? "" : "s"}</strong> in ${nRepos} repo${nRepos === 1 ? "" : "s"}, from the folders your Claude Code sessions have worked in over the last 30 days.` : "No worktrees yet. Repos appear here once a Claude Code session has worked in them, or add a folder below."}</p>
     ${nRepos ? `<div class="repo-list">${state.repos.map((r) => `<div><strong>${esc(r.name)}</strong> <code>${esc(tilde(r.root))}</code>${r.github ? ` <span class="muted">${esc(r.github)}</span>` : ""}</div>`).join("")}</div>` : ""}
     <details ${welcome && state.worktrees.length ? "" : "open"}><summary>Also scan these folders</summary>${foldersHtml()}</details>`
  ));
  const hookAgo = I?.claude.lastHookAt ? ago(I.claude.lastHookAt) : null;
  steps.push(stepHtml(
    !I ? ICON_WAIT : state.sessions.length || hookAgo ? ICON_OK : ICON_TODO,
    "Claude Code",
    `<p>${state.sessions.length} live session${state.sessions.length === 1 ? "" : "s"}.
      Reviews you send are handed to the session working in that worktree when it finishes its current turn, or with your next message to it.</p>
     <p class="muted">${hookAgo ? `Last heard from a session's hook ${hookAgo}.` : "Haven't heard from a session's hook yet. That happens the next time you send a message in a session started after installing the plugin."}</p>`
  ));
  let ghBody;
  if (!I) ghBody = '<p class="muted">Checking…</p>';
  else if (!I.gh.installed) ghBody = `<p>Install the GitHub CLI to see PR status and clean up merged worktrees: ${cmd("brew install gh")} then ${cmd("gh auth login")}</p>`;
  else if (!I.gh.authed) ghBody = `<p>The GitHub CLI isn't signed in. Run ${cmd("gh auth login")} in a terminal, then check again.</p>`;
  else ghBody = `<p>Signed in as <strong>${esc(I.gh.account || "unknown")}</strong>. PR status and merged-worktree cleanup are available.</p>`;
  steps.push(stepHtml(
    !I ? ICON_WAIT : I.gh.authed ? ICON_OK : ICON_TODO,
    "GitHub",
    ghBody + `<label class="setting"><input type="checkbox" data-cfg="autoCleanup" ${c.autoCleanup ? "checked" : ""}>
      <span><strong>Remove worktrees when their PR merges</strong><br><span class="muted">Only when the worktree is clean, no Claude session is using it, its HEAD is in the merged PR and it has no unsent comments. PRs merged before you installed this are left for you to remove.</span></span></label>`
  ));
  const login = state.coderabbitLogin;
  let crBody, crIcon = ICON_OPT;
  if (!I) {
    crBody = '<p class="muted">Checking…</p>';
    crIcon = ICON_WAIT;
  } else if (!I.coderabbit.installed) {
    crBody = `<p>Optional. With the CodeRabbit CLI you can ask CodeRabbit to review a worktree before it's a PR, and send its findings to Claude.</p>
      <p>Install it with ${cmd("brew install coderabbit")} or ${cmd("curl -fsSL https://cli.coderabbit.ai/install.sh | sh")}, then <button class="link-btn" data-act="recheck">check again</button>.</p>`;
  } else if (!I.coderabbit.authed) {
    crBody = `<p>CodeRabbit CLI ${esc(I.coderabbit.version || "")} is installed. Sign in to use it here. If your company has CodeRabbit on GitHub, reviews of its repos use the company plan.</p>
      ${login?.running ? `<p><strong>Finish signing in in the browser window that opened.</strong> ${login.url ? `<a href="${esc(login.url)}" target="_blank">Open the sign-in page</a> if it didn't.` : ""}</p>` : `<div class="actions"><button class="btn primary" data-act="cr-login">Sign in to CodeRabbit</button></div>`}
      ${login?.error ? `<p class="error">${esc(login.error)}</p>` : ""}`;
  } else {
    crIcon = ICON_OK;
    const cr = I.coderabbit;
    const orgs = cr.orgs;
    crBody = `<table class="kv">
        <tr><td>Account</td><td><strong>${esc(cr.user)}</strong>${cr.email ? ` <span class="muted">${esc(cr.email)}</span>` : ""}</td></tr>
        <tr><td>Organization</td><td>${esc(cr.org || "—")}${orgs && orgs.length > 1 ? ` <span class="muted">(also: ${orgs.filter((o) => o !== cr.org).map(esc).join(", ")})</span>` : ""}</td></tr>
        ${cr.plan ? `<tr><td>Plan</td><td>${esc(cr.plan)}${cr.seat ? ` · seat ${esc(cr.seat)}` : ""}</td></tr>` : ""}
        <tr><td>CLI</td><td>${esc(cr.version || "")}</td></tr>
      </table>
      <p class="muted">Reviews count against the organization that owns each repo. To change your default organization, run ${cmd("coderabbit auth org")} in a terminal.</p>
      ${welcome ? "" : '<div class="actions"><button class="btn small" data-act="cr-logout">Sign out</button></div>'}`;
  }
  steps.push(stepHtml(crIcon, 'CodeRabbit <span class="muted small">optional</span>', crBody));
  const cli = I?.claude.cliVersion;
  steps.push(stepHtml(!I ? ICON_WAIT : cli ? ICON_OK : ICON_OPT, 'Code review by Claude <span class="muted small">optional</span>', !I ? '<p class="muted">Checking…</p>' : cli ? `<p>Claude can review a worktree with Claude Code's built-in <code>/code-review</code> (claude ${esc(cli)}). It runs on this machine as a separate, read-only session and counts toward your Claude usage.</p>
      <label class="setting row"><span>Effort to start with</span>
        <select data-cfg="reviewEffort">${EFFORT_OPTIONS.map(([v, l]) => `<option value="${v}" ${c.reviewEffort === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <p class="muted">You can pick a different effort each time you run a review. Higher effort looks harder and takes longer.</p>` : `<p>The <code>claude</code> command wasn't found on this server's PATH, so Claude can't run code reviews here. Make sure it's on your PATH, then <button class="link-btn" data-act="recheck">check again</button>.</p>`));
  const notif = !("Notification" in window) ? "unsupported" : Notification.permission;
  steps.push(stepHtml(ICON_OK, "Preferences", `
    <label class="setting row"><span>Open files in</span>
      <select data-cfg="editor">${EDITOR_OPTIONS.map(([v, l]) => `<option value="${v}" ${c.editor === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
    <div class="setting row"><span>Desktop notifications when a session finishes work you haven't reviewed</span>
      ${notif === "granted" ? '<span class="muted">On</span>' : notif === "denied" ? '<span class="muted">Blocked in browser settings</span>' : notif === "unsupported" ? '<span class="muted">Not supported here</span>' : '<button class="btn small" data-act="enable-notifications">Turn on</button>'}</div>
    ${welcome ? "" : `
    <label class="setting row"><span>Count a worktree as recent for</span><span><input type="number" min="1" max="90" data-cfg="recentDays" value="${c.recentDays}"> days</span></label>
    <label class="setting row"><span>Check PR status every</span><span><input type="number" min="1" max="60" data-cfg="prPollMinutes" value="${c.prPollMinutes}"> minutes</span></label>`}`));
  if (!welcome) {
    steps.push(stepHtml(ICON_OK, "About", `<table class="kv">
      <tr><td>Version</td><td>${esc(state.version)}</td></tr>
      <tr><td>Data</td><td><code>${esc(tilde(I?.dataDir || ""))}</code></td></tr>
      <tr><td>Node</td><td>${esc(I?.node || "")}</td></tr></table>
      <div class="actions"><button class="btn small" data-act="rerun-setup">Run setup again</button></div>`));
  }
  return `<div class="page setup">
    <div class="title-row"><h1>${welcome ? "Welcome to Worktree Review" : "Settings"}</h1>
      <button class="btn small" data-act="recheck">Check again</button></div>
    <p class="lede">${welcome ? "Review what Claude is doing in your git worktrees the way you'd review a PR, then send comments straight back to the session. A quick check of what's connected:" : "Integrations and preferences. Changes save as you make them."}</p>
    ${steps.join("")}
    ${welcome ? '<div class="actions finish"><button class="btn primary" data-act="finish-setup">Start reviewing</button></div>' : ""}
  </div>`;
}
function setupSig(s) {
  if (S.page === "cleanup") return JSON.stringify([s.jobs, s.worktrees.map((w) => [w.id, w.cleanup, w.busy, w.sessions.length, w.agents.length, w.pr?.state])]);
  return JSON.stringify([s.coderabbitLogin, s.config, s.repos, s.sessions.length, s.worktrees.length, s.onboardedAt]);
}
async function saveConfig(patch2) {
  try {
    await api("POST", "/api/config", patch2);
    toast("Saved");
  } catch (e) {
    toast(errMsg(e), true);
  }
}

// src/web/loading.ts
async function loadView({ quiet = false } = {}) {
  const wt = curWt();
  if (!wt) {
    renderMain();
    return;
  }
  const seq = ++S.seq;
  const mode = S.mode || (wt.review.reviewedAt ? "since" : "full");
  try {
    const [diff, cm] = await Promise.all([
      api("GET", `/api/worktrees/${wt.id}/diff?mode=${mode}`),
      api("GET", `/api/worktrees/${wt.id}/comments`)
    ]);
    if (seq !== S.seq) return;
    S.mode = diff.mode;
    let files, groups = null;
    if (diff.mode === "commits") {
      const gs = diff.commits.map((c) => ({ ...c, files: parseDiff(c.diff).map((f) => ({ ...f, commit: c.sha, commitN: c.n, uid: `${c.sha}~${f.path}` })) }));
      const unc = parseDiff(diff.uncommitted).map((f) => ({ ...f, commit: null, commitN: 0, uncommitted: true, uid: `u~${f.path}` }));
      if (unc.length) gs.push({ n: 0, sha: null, subject: "Uncommitted changes", files: unc });
      groups = gs;
      files = gs.flatMap((g) => g.files);
    } else {
      const first = (p) => {
        const ns = (diff.fileCommits?.[p] || []).filter((n) => n > 0);
        return ns.length ? Math.min(...ns) : Infinity;
      };
      files = parseDiff(diff.diff).map((f) => ({ ...f, commit: null, uid: f.path })).map((f, i) => ({ f, i, k: first(f.path) })).sort((a, b) => a.k - b.k || a.i - b.i).map((x) => x.f);
    }
    const prev = S.view;
    const v = { wtId: wt.id, diff, files, groups, comments: cm.comments, reviews: cm.reviews, commentSig: wt.comments.sig, crSig: reviewsSig(wt), blame: prev?.wtId === wt.id && prev.blame?.fingerprint === diff.fingerprint ? prev.blame : null };
    S.view = v;
    if (diff.mode !== "commits" && !v.blame && diff.commits.length) {
      api("GET", `/api/worktrees/${wt.id}/blame`).then((b) => {
        if (seq !== S.seq || !S.view || b.fingerprint !== S.view.diff.fingerprint) return;
        S.view.blame = b;
        applyBlame();
      }, () => {
      });
    }
    await loadCodeReviews();
    if (seq !== S.seq) return;
    S.stale = false;
    renderMain();
    refreshFileBlames(v);
  } catch (e) {
    if (seq !== S.seq) return;
    if (!quiet) need("#main").innerHTML = `<div class="page">${headerHtml(wt)}<div class="callout warn">${esc(errMsg(e))}</div></div>`;
  }
}
async function reloadComments() {
  if (!S.view) return;
  const cm = await api("GET", `/api/worktrees/${S.view.wtId}/comments`);
  S.view.comments = cm.comments;
  S.view.reviews = cm.reviews;
  renderMain();
}
function select(id) {
  if (S.selId === id) return;
  S.selId = id;
  S.mode = null;
  S.view = null;
  S.bases.delete(id);
  S.baseOther = null;
  const wt = S.st?.worktrees.find((w) => w.id === id);
  if (wt) loadBases(wt);
  S.toggled.clear();
  S.forceRender.clear();
  S.editors.clear();
  S.shutCommits.clear();
  S.openBodies.clear();
  S.hl = null;
  need("#main").scrollTop = 0;
  renderSidebar();
  renderMain();
  loadView();
}
function onHash() {
  const id = location.hash.replace(/^#\/?/, "") || null;
  if (id === "settings" || id === "welcome" || id === "cleanup") {
    S.page = id;
    S.selId = null;
    S.view = null;
    S.setupSig = S.st ? setupSig(S.st) : null;
    need("#main").scrollTop = 0;
    renderSidebar();
    renderMain();
    loadIntegrations();
    return;
  }
  S.page = null;
  if (id && S.st && !S.st.onboardedAt) api("POST", "/api/onboarding", { done: true }).catch(() => {
  });
  const fallback = !id && S.st?.onboardedAt ? defaultWorktree(S.st.worktrees) : void 0;
  if (fallback) {
    location.replace(`#/${fallback.id}`);
    return;
  }
  if (id) select(id);
  else {
    S.selId = null;
    renderSidebar();
    renderMain();
  }
}
function refreshFileBlames(v) {
  for (const f of v.files) {
    if (!S.blameOn.has(f.uid) || f.commit || S.fileBlame.has(blameKey(f))) continue;
    const key = blameKey(f);
    api("GET", `/api/worktrees/${v.wtId}/blame/file?path=${encodeURIComponent(f.path)}`).then((b) => {
      S.fileBlame.set(key, b);
      if (S.view === v) redrawFile(f);
    }, () => {
      S.blameOn.delete(f.uid);
      if (S.view === v) redrawFile(f);
    });
  }
}

// src/web/header.ts
var STATUS = { " M": "modified", "M ": "staged", MM: "staged + modified", "A ": "new, staged", AM: "new, staged", " D": "missing", "D ": "deleted, staged", "??": "untracked", "R ": "renamed" };
function headerHtml(wt) {
  const name = wt.branch || `detached @ ${wt.head?.slice(0, 10)}`;
  const pr = wt.pr ? ` <a class="pr-no" href="${esc(wt.pr.url)}" target="_blank">#${wt.pr.number}</a>` : "";
  const cs = wt.cleanup;
  let cleanup = "";
  const err = wt.error ? `<div class="callout danger"><strong>${wt.error.kind === "broken-link" ? "Git can't read this worktree" : "Git reported a problem with this worktree"}</strong>
        <p>${esc(wt.error.message)}</p>
        ${wt.error.detail && wt.error.detail !== wt.error.message ? `<details><summary>Git's message</summary><code class="cmd">${esc(wt.error.detail)}</code></details>` : ""}
        ${wt.error.kind === "broken-link" ? '<div class="actions" style="margin-top:8px"><button class="btn primary" data-act="repair">Repair links</button></div>' : ""}</div>` : "";
  const removeErr = S.removeErrors[wt.id] ? `<div class="callout danger"><strong>Couldn't remove this worktree.</strong><p>${esc(S.removeErrors[wt.id])}</p></div>` : "";
  if (cs?.kind === "idle" && !inUse(wt) && (cs.eligible || cs.forceable)) {
    cleanup = `<div class="callout small">No Claude session is using this worktree.
      ${wt.busy ? '<span class="muted"><span class="dot busy"></span> Removing…</span>' : cs.eligible ? '<button class="link-btn" data-act="remove">Remove it</button> (the branch is kept)' : `<button class="link-btn" data-act="remove-anyway">Remove anyway…</button> <span class="muted">(${esc(cs.reasons.join("; "))})</span>`}
      · <a class="link-btn" href="#/cleanup">Clean up others</a></div>`;
  } else if (cs?.kind === "merged") {
    const files = cs.dirty ? `<details ${cs.dirty.kind === "work" && cs.dirty.count <= 20 ? "open" : ""}><summary>${cs.dirty.count} uncommitted file${cs.dirty.count === 1 ? "" : "s"}</summary>
        <ul class="file-list">${cs.dirty.files.map((f) => `<li><code>${esc(f.file)}</code> <span class="muted small">${esc(STATUS[f.xy] || f.xy.trim())}</span></li>`).join("")}${cs.dirty.count > cs.dirty.files.length ? `<li class="muted">…and ${cs.dirty.count - cs.dirty.files.length} more</li>` : ""}</ul></details>` : "";
    const commits = cs.unmatched?.length ? `<details><summary>${cs.unmatched.length} commit${cs.unmatched.length === 1 ? "" : "s"} with no matching change in the PR (kept on the branch)</summary>
        <ul class="file-list">${cs.unmatched.map((c) => `<li><code>${esc(c.sha.slice(0, 8))}</code> ${esc(c.subject)}</li>`).join("")}</ul></details>` : "";
    const notes = cs.notes.length ? `<ul class="notes">${cs.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : "";
    const busy = wt.busy ? '<span class="muted"><span class="dot busy"></span> Removing…</span>' : "";
    cleanup = cs.eligible ? `<div class="callout merged"><strong>PR merged.</strong> Nothing uncommitted would be lost and nothing is using it. ${cs.auto && st().config.autoCleanup ? "It will be removed automatically in a moment." : "It was merged before auto-cleanup was set up, so it waits for you."}
          ${notes}${files}${commits}
          <div class="actions" style="margin-top:8px">${busy || `<button class="btn danger" data-act="remove">Remove worktree${cs.branchSafe ? " and branch" : ""}</button>`}</div></div>` : `<div class="callout warn"><strong>PR merged, but removing this worktree could lose something:</strong>
          <ul>${cs.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>${notes}${files}${commits}
          ${cs.forceable ? `<div class="actions" style="margin-top:8px">${busy || '<button class="btn danger" data-act="remove-anyway">Remove anyway…</button><span class="muted small">The branch is kept either way.</span>'}</div>` : ""}</div>`;
  }
  if (wt.isMain && wt.pr?.state === "MERGED") {
    cleanup = `<div class="callout merged small"><strong>PR merged.</strong> This is the repository's own folder, so it's never removed.
      Switch it back with <code>git switch ${esc(wt.pr.baseRefName)} &amp;&amp; git pull</code>.</div>`;
  }
  return `<div class="title-row"><h1>${esc(name)}${pr}</h1>
      <div class="actions">${prChip(wt.pr)}${wt.sessions.map(sessionChip).join("")}${wt.agents.map(agentChip).join("")}</div></div>
    ${wt.pr ? `<div class="meta">${esc(wt.pr.title)}</div>` : ""}
    ${headerMetaHtml(wt)}
    ${err}${removeErr}
    ${wt.baseError && !wt.error ? `<div class="callout warn">${esc(wt.baseError)}. Pick a different one in Compare with above.</div>` : ""}
    ${cleanup}`;
}
var ICON_REPO = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8Z"/></svg>';
var ICON_COPY = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Zm5-5C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/></svg>';
var ICON_COMPARE = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM6 12v-1.646a.25.25 0 0 1 .427-.177l2.396 2.396a.25.25 0 0 1 0 .354l-2.396 2.396A.25.25 0 0 1 6 15.146V13.5H5A2.5 2.5 0 0 1 2.5 11V5.372a2.25 2.25 0 1 1 1.5 0V11a1 1 0 0 0 1 1ZM4 3.25a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0ZM12.75 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"/></svg>';
var OTHER_REF = "__other";
function headerMetaHtml(wt) {
  const editor = editorLink(wt.path);
  const counts = `${wt.ahead} commit${wt.ahead === 1 ? "" : "s"}${wt.dirty ? ` + ${wt.dirty} uncommitted` : ""}`;
  return `<div class="wt-meta">
    <div class="meta-row">
      <span class="meta-item" title="Repository">${ICON_REPO}${esc(wt.repoName)}</span>
      <span class="path-chip" title="${esc(wt.path)}"><span class="mono">${esc(tilde(wt.path))}</span><button class="icon-btn" data-act="copy-path" title="Copy path" aria-label="Copy path">${ICON_COPY}</button></span>
      ${editor ? `<a class="btn small" href="${esc(editor)}">Open in ${editorName()}</a>` : ""}
    </div>
    <div class="meta-row">
      <span class="meta-item compare" title="The diff shows what changed since this ref">${ICON_COMPARE}Compare with ${baseControlHtml(wt)}</span>
      <span class="muted">${counts} · updated ${ago(wt.lastActivity)}</span>
    </div>
  </div>`;
}
function baseControlHtml(wt) {
  if (S.baseOther === wt.id) {
    return `<span class="base-other"><input id="base" value="${esc(wt.baseRef || "")}" placeholder="branch, tag or commit" spellcheck="false" data-act="base-input">
      <button class="btn small primary" data-act="set-base">Compare</button><button class="btn small" data-act="base-other-cancel">Cancel</button></span>`;
  }
  const c = S.bases.get(wt.id);
  const overridden = wt.baseSource === "set by you";
  const auto = c?.automatic ?? (overridden ? null : { ref: wt.baseRef ?? "", source: wt.baseSource ?? "" });
  const opt = (value, label, selected) => `<option value="${esc(value)}"${selected ? " selected" : ""}>${esc(label)}</option>`;
  const current = wt.baseRef ?? "";
  const listed = /* @__PURE__ */ new Set([...c?.branches ?? [], ...c?.remotes ?? []]);
  const options = [
    auto ? opt("", `${auto.ref} (automatic: ${auto.source})`, !overridden) : opt("", "Automatic", !overridden),
    overridden && !listed.has(current) ? opt(current, current, true) : "",
    c?.branches.length ? `<optgroup label="Branches">${c.branches.map((b) => opt(b, b, overridden && b === current)).join("")}</optgroup>` : "",
    c?.remotes.length ? `<optgroup label="Remote branches">${c.remotes.map((b) => opt(b, b, overridden && b === current)).join("")}</optgroup>` : "",
    opt(OTHER_REF, "Other branch, tag or commit…", false)
  ];
  return `<select class="base-select" data-act="base-select" aria-label="Compare with">${options.join("")}</select>`;
}
function loadBases(wt) {
  if (S.bases.has(wt.id) || S.basesLoading.has(wt.id)) return;
  S.basesLoading.add(wt.id);
  api("GET", `/api/worktrees/${wt.id}/bases`).then((c) => {
    S.bases.set(wt.id, c);
    redrawHeaderMeta();
  }, () => {
  }).finally(() => S.basesLoading.delete(wt.id));
}
function redrawHeaderMeta() {
  const wt = S.st?.worktrees.find((w) => w.id === S.selId);
  const el = need("#main").querySelector(".wt-meta");
  if (!wt || !el) return;
  el.outerHTML = headerMetaHtml(wt);
  if (S.baseOther === wt.id) need("#base").focus();
}
async function chooseBase(value) {
  if (value === OTHER_REF) {
    S.baseOther = S.selId;
    redrawHeaderMeta();
    return;
  }
  try {
    await api("POST", `/api/worktrees/${S.selId}/base`, { base: value });
    S.view = null;
    loadView();
  } catch (e) {
    toast(errMsg(e), true);
    redrawHeaderMeta();
  }
}

// src/web/view.ts
function renderMain() {
  const main = need("#main");
  if (S.page) {
    const scroll2 = main.scrollTop;
    main.innerHTML = S.page === "cleanup" ? cleanupPageHtml() : setupHtml(S.page);
    main.scrollTop = scroll2;
    return;
  }
  if (!S.selId) {
    main.innerHTML = '<div class="empty">Pick a worktree on the left.</div>';
    return;
  }
  const wt = curWt();
  if (!wt) {
    const gone = S.st?.cleaned.find((c) => location.hash.includes(c.path));
    main.innerHTML = `<div class="empty">${gone ? "This worktree was cleaned up after its PR merged." : "This worktree no longer exists."}</div>`;
    return;
  }
  if (!S.view || S.view.wtId !== wt.id) {
    main.innerHTML = `<div class="page">${headerHtml(wt)}<div class="file-note">Loading diff…</div></div>`;
    return;
  }
  const v = S.view;
  const byAnchor2 = commentsByAnchor(v.comments);
  beginRender(main, byAnchor2);
  const mode = v.diff.mode;
  const since = mode === "since";
  const byCommit = mode === "commits";
  const groups = v.groups ?? [];
  const hiddenCommits = v.diff.mode === "commits" ? v.diff.hiddenCommits : 0;
  let filesHtml;
  if (byCommit) {
    filesHtml = groups.map((g) => groupHtml(g, byAnchor2)).join("") + (hiddenCommits ? `<div class="callout small">${hiddenCommits} older commits aren't shown.</div>` : "");
  } else {
    filesHtml = v.files.map((f) => renderFile(f, byAnchor2)).join("");
  }
  const { orphan, otherView } = unplacedComments(v);
  const orphanPanel = orphanHtml(orphan);
  v.orphanHtml = orphanPanel;
  const viewedCount = v.files.filter((f) => v.diff.viewed[f.path] === f.hash).length;
  v.headerSig = headerSig(wt);
  const scroll = main.scrollTop;
  main.innerHTML = `<div class="page" ${S.hl !== null && S.hl !== void 0 && !byCommit ? `data-hl="${S.hl}"` : ""}>
    ${headerHtml(wt)}
    ${commitsHtml(v.diff.commits, wt)}
    <div class="toolbar">
      <div class="actions">
        <div class="seg">
          <button data-act="mode" data-mode="full" class="${since || byCommit ? "" : "on"}">All changes</button>
          <button data-act="mode" data-mode="commits" class="${byCommit ? "on" : ""}" ${v.diff.commits.length || wt.dirty ? "" : "disabled"} title="Each commit's changes in the order they were made">By commit</button>
          <button data-act="mode" data-mode="since" class="${since ? "on" : ""}" ${v.diff.sinceAvailable ? "" : 'disabled title="Mark as reviewed first"'}>Since last review${v.diff.reviewedAt ? ` (${ago(v.diff.reviewedAt)})` : ""}</button>
        </div>
        ${byCommit ? `<span class="progress">${v.diff.commits.length} commit${v.diff.commits.length === 1 ? "" : "s"}, oldest first</span>` : `<span class="progress">${viewedCount} / ${v.files.length} files viewed</span>`}
      </div>
      <div class="actions">
        ${S.stale ? '<span class="banner">New changes landed. <button class="btn small" data-act="refresh">Refresh</button></span>' : ""}
        ${reviewButtonHtml(wt)}
        ${collapseAllHtml(v)}
        <button class="btn" data-act="mark-reviewed" title="Remember this exact state so you can see only what changes next">Mark as reviewed</button>
      </div>
    </div>
    ${reviewPanelsHtml(wt)}
    ${v.diff.mode !== "commits" && v.diff.truncated ? '<div class="callout warn">This diff is very large and was cut off.</div>' : ""}
    ${orphanPanel}
    ${otherViewHtml(otherView, byCommit)}
    ${byCommit ? filesHtml : v.files.length ? filesSummaryHtml(v) + filesHtml : `<div class="callout">${since ? "Nothing has changed since your last review." : `No changes against <code>${esc(v.diff.baseRef)}</code>.`}</div>`}
  </div>
  ${reviewBarHtml(wt)}`;
  main.scrollTop = scroll;
  endRender(main);
  applyHighlight();
  if (S.scrollTo) {
    document.getElementById(S.scrollTo)?.scrollIntoView({ block: "start" });
    S.scrollTo = null;
  }
  if (S.focusEk) {
    const ta = main.querySelector(`textarea[data-ek="${CSS.escape(S.focusEk)}"]`);
    if (ta) {
      ta.focus();
      ta.selectionStart = ta.selectionEnd = ta.value.length;
    }
    S.focusEk = null;
  }
}
var commentsByAnchor = (comments) => {
  const byAnchor2 = /* @__PURE__ */ new Map();
  for (const c of comments) {
    const k = keyOf(c.file, c.side, c.line, c.commit);
    const here = byAnchor2.get(k);
    if (here) here.push(c);
    else byAnchor2.set(k, [c]);
  }
  return byAnchor2;
};
function groupHtml(g, byAnchor2) {
  const shut = S.shutCommits.has(g.n);
  return `<section class="commit-group ${commitClass(g.n)} ${shut ? "shut" : ""}" id="cg-${g.n}">
      <div class="commit-head"><button class="caret" data-act="toggle-commit" data-n="${g.n}" aria-expanded="${!shut}" aria-label="${shut ? "Expand" : "Collapse"} this commit" title="${shut ? "Expand" : "Collapse"} this commit">${shut ? "▸" : "▾"}</button><span class="cnum">${g.n ? `#${g.n}` : "±"}</span>
        <span class="commit-title">${esc(g.subject)}</span>
        <span class="muted small">${g.sha ? `<span class="mono">${g.sha.slice(0, 8)}</span> · ${esc(g.author)} · ${ago(g.time)} · ` : ""}${g.files.length} file${g.files.length === 1 ? "" : "s"}</span></div>
      ${shut || !g.body ? "" : commitBodyHtml(g.body, g.n)}
      ${shut ? "" : `<div class="commit-files">${g.truncated ? '<div class="callout warn small">This commit is too large to show in full.</div>' : ""}
      ${g.files.map((f) => renderFile(f, byAnchor2)).join("") || '<div class="file-note">No file changes.</div>'}</div>`}
    </section>`;
}
function unplacedComments(v) {
  const byCommit = v.diff.mode === "commits";
  const placed = placedCommentIds(v);
  const unplaced = v.comments.filter((c) => !placed.has(c.id) && c.status !== "resolved");
  return { orphan: unplaced.filter((c) => byCommit ? !!c.commit : !c.commit), otherView: unplaced.filter((c) => byCommit ? !c.commit : !!c.commit) };
}
var orphanHtml = (orphan) => orphan.length ? `<div class="panel"><div class="panel-head">Comments on files not in this view</div><div class="panel-body threads">${orphan.map((c) => `<div class="mono">${esc(c.file)}:${c.line}</div>${threadHtml(c)}`).join("")}</div></div>` : "";
var otherViewHtml = (otherView, byCommit) => otherView.length ? `<details class="panel"><summary class="panel-head" style="cursor:pointer">${otherView.length} comment${otherView.length === 1 ? "" : "s"} made in the ${byCommit ? "All changes" : "By commit"} view
        <button class="btn small" data-act="mode" data-mode="${byCommit ? "full" : "commits"}">Show there</button></summary>
      <div class="panel-body threads">${otherView.map((c) => `<div class="mono">${esc(c.file)}:${c.line}${c.commit ? ` · ${c.commit.slice(0, 8)}` : ""}</div>${threadHtml(c)}`).join("")}</div></details>` : "";
var collapseAllHtml = (v) => v.diff.mode === "commits" && (v.groups ?? []).every((g) => S.shutCommits.has(g.n)) ? '<button class="btn" data-act="expand-all">Expand all</button>' : '<button class="btn" data-act="collapse-all">Collapse all</button>';
var headerSig = (wt) => JSON.stringify([wt.sessions, wt.agents, wt.pr, wt.cleanup, wt.ahead, wt.dirty, wt.baseRef, wt.baseError, wt.error, wt.busy, S.removeErrors[wt.id], st().sessions.length, st().config]);
function commitsHtml(commits, wt) {
  if (!commits.length && !wt.dirty) return "";
  const byCommit = S.view?.diff.mode === "commits";
  const canHl = !byCommit && !!S.view?.blame;
  const row = (n, sha, subject, time, body) => `<div class="commit ${S.hl === n && canHl ? "hl" : ""}" ${body ? `title="${esc(`${subject}

${body}`)}"` : ""}>
      <button class="cswatch ${commitClass(n)}" data-act="hl-commit" data-n="${n}" ${canHl ? "" : "disabled"} title="${canHl ? "Highlight the lines from this commit" : byCommit ? "" : "Working out which lines came from which commit…"}">${n ? `#${n}` : "±"}</button>
      ${sha ? `<span class="mono">${sha.slice(0, 8)}</span>` : ""}<span class="subject">${esc(subject)}</span>
      <span class="when">${time ? ago(time) : ""}</span>
      <button class="link-btn" data-act="view-commit" data-n="${n}">view</button></div>`;
  const rows = commits.map((c) => row(c.n, c.sha, c.subject, c.time, c.body));
  if (wt.dirty) rows.push(row(0, null, `Uncommitted changes (${wt.dirty} file${wt.dirty === 1 ? "" : "s"})`, null));
  return `<details class="panel commits-panel" ${commits.length <= 8 ? "open" : ""}><summary class="panel-head" style="cursor:pointer">${commits.length} commit${commits.length === 1 ? "" : "s"}, oldest first
      ${S.hl !== null && S.hl !== void 0 && canHl ? '<button class="btn small" data-act="hl-commit" data-n="">Clear highlight</button>' : ""}</summary>
    <div class="panel-body">${rows.join("")}</div></details>`;
}
var TRAILER = /^[A-Z][A-Za-z-]+: .+/;
function commitBodyHtml(body, n) {
  const lines = body.split("\n");
  let cut = lines.length;
  while (cut > 0 && (TRAILER.test(lines[cut - 1] ?? "") || !(lines[cut - 1] ?? "").trim())) cut--;
  const trailerBlock = lines.slice(cut).filter((l) => l.trim());
  const isTrailers = trailerBlock.length && trailerBlock.every((l) => TRAILER.test(l));
  const main = (isTrailers ? lines.slice(0, cut) : lines).join("\n").trim();
  const long = main.split("\n").length > 6 || main.length > 600;
  const open = S.openBodies.has(n);
  return `<div class="commit-body ${long && !open ? "clamped" : ""} ${main ? "" : "trailers-only"}">
    ${main ? `<div class="commit-msg">${md(main)}</div>` : ""}
    ${isTrailers ? `<div class="commit-trailers">${trailerBlock.map(esc).join("<br>")}</div>` : ""}
    ${long ? `<button class="link-btn" data-act="toggle-body" data-n="${n}">${open ? "Show less" : "Show full message"}</button>` : ""}
  </div>`;
}
function applyHighlight() {
  let el = document.getElementById("hl-style");
  if (!el) {
    el = document.createElement("style");
    el.id = "hl-style";
    document.head.appendChild(el);
  }
  const n = S.hl;
  el.textContent = n === null || n === void 0 ? "" : `
    .page[data-hl="${n}"] tr.line.add:not([data-c="${n}"]) td, .page[data-hl="${n}"] tr.line.del td { opacity: .28; }
    .page[data-hl="${n}"] tr.line.add[data-c="${n}"] td.code { box-shadow: inset 3px 0 0 var(--c-hl, currentColor); }`;
}
function filesSummaryHtml(v) {
  if (v.files.length < 2) return "";
  return `<details class="panel files-summary" ${v.files.length <= 25 ? "open" : ""}><summary class="panel-head" style="cursor:pointer">${v.files.length} files changed
      <span><span class="stat-add">+${v.files.reduce((n, f) => n + f.add, 0)}</span> <span class="stat-del">−${v.files.reduce((n, f) => n + f.del, 0)}</span></span></summary>
    <div class="panel-body">${v.files.map((f) => {
    const viewed = v.diff.viewed[f.path] === f.hash;
    const nc = v.comments.filter((c) => c.file === f.path && c.status !== "resolved").length;
    return `<div class="row ${viewed ? "viewed" : ""}"><input type="checkbox" data-act="viewed" data-file="${esc(f.path)}" ${viewed ? "checked" : ""} title="Viewed">
        <a href="#" data-act="jump" data-file="${esc(f.path)}">${esc(f.path)}</a>${nc ? `<span class="chip comments">${nc}</span>` : ""}
        <span class="stat-add">+${f.add}</span><span class="stat-del">−${f.del}</span></div>`;
  }).join("")}</div></details>`;
}
function reviewBarHtml(wt) {
  const v = view();
  const drafts = v.comments.filter((c) => c.status === "draft");
  const summary = S.summaries[wt.id] || "";
  const pending = v.reviews;
  const live = st().sessions;
  const linked = wt.sessions;
  const open = drafts.length || summary || pending.length;
  const target = S.summaries[`${wt.id}:target`] || "";
  const options = [`<option value="">${linked.length ? `Claude session working here (${linked.map((s) => esc(s.name)).join(", ")})` : "First Claude session that works here"}</option>`].concat(live.map((s) => `<option value="${esc(s.sessionId)}" ${target === s.sessionId ? "selected" : ""}>${esc(s.name)} (${esc(s.status)})${linked.some((l) => l.sessionId === s.sessionId) ? " · working here" : ""}</option>`));
  return `<details class="review-bar" ${open ? "open" : ""}>
    <summary><span>Review</span><span class="progress">${drafts.length} draft comment${drafts.length === 1 ? "" : "s"}${pending.length ? ` · ${pending.length} waiting` : ""}</span></summary>
    <div class="body">
      <textarea data-ek="summary" placeholder="Overall feedback (optional)">${esc(summary)}</textarea>
      <div class="actions">
        <select data-act="target" title="Which Claude session gets this review">${options.join("")}</select>
        <span style="flex:1"></span>
        <button class="btn" data-act="copy-prompt" ${drafts.length || pending.length ? "" : "disabled"}>Copy as prompt</button>
        <button class="btn primary" data-act="submit" ${drafts.length || summary.trim() ? "" : "disabled"}>Send to Claude</button>
      </div>
      <div class="note">${linked.length ? "Delivered when that session finishes what it's doing, or with your next message to it." : "No Claude session is working in this worktree right now. It'll go to the first one that does, or copy it as a prompt."}</div>
      ${pending.length ? `<div class="pending-list">${pending.map((r) => `<div>Review with ${r.commentIds.length} comment${r.commentIds.length === 1 ? "" : "s"} waiting since ${ago(r.createdAt)} · <button class="link-btn" data-act="cancel-review" data-id="${r.id}">take back</button></div>`).join("")}</div>` : ""}
    </div>
  </details>`;
}
function applyBlame() {
  const page = need("#main").querySelector(":scope > .page");
  if (!S.view?.headerSig) return;
  if (!page || S.view.diff.mode === "commits") {
    renderMain();
    return;
  }
  for (const row of page.querySelectorAll("section.file tr.line.add:not([data-c])")) {
    const k = row.dataset.k;
    if (!k) continue;
    const { commit, file, line } = parseKey(k);
    if (commit) continue;
    const cn = commitOfLine(file, line);
    if (cn === void 0) continue;
    row.dataset.c = String(cn);
    row.querySelector("td.code")?.insertAdjacentHTML("afterbegin", cbarHtml(cn));
  }
  for (const b of page.querySelectorAll(".commits-panel .cswatch[disabled]")) {
    b.disabled = false;
    b.title = "Highlight the lines from this commit";
  }
}

// src/web/collapse.ts
function replaceWith(el, html) {
  el.outerHTML = html;
}
function syncOrphan(page, v) {
  const html = orphanHtml(unplacedComments(v).orphan);
  if (html === v.orphanHtml) return true;
  v.orphanHtml = html;
  const cur = page.querySelector(":scope > div.panel");
  if (cur) {
    if (html) {
      replaceWith(cur, html);
      return true;
    }
    const a = cur.previousSibling, b = cur.nextSibling;
    cur.remove();
    if (a instanceof Text && b instanceof Text) {
      a.data += b.data;
      b.remove();
    }
    return true;
  }
  if (!html) return true;
  const toolbar = page.querySelector(":scope > .toolbar");
  if (!toolbar) return false;
  let prev = toolbar, slot = -1;
  let next = prev.nextElementSibling;
  if (next?.matches(".cr-panels")) {
    prev = next;
    slot = 0;
    next = next.nextElementSibling;
  }
  if (next?.matches("div.callout.warn")) {
    prev = next;
    slot = 1;
  }
  const ws = prev.nextSibling;
  const SEP = "\n    ".length;
  const nextSlot = prev.nextElementSibling?.matches("details.panel:not(.commits-panel):not(.files-summary)") ? 3 : 4;
  if (!(ws instanceof Text) || ws.length < (nextSlot - slot) * SEP) return false;
  const tail = ws.splitText((2 - slot) * SEP);
  const t = document.createElement("template");
  t.innerHTML = html;
  const el = t.content.firstElementChild;
  if (!el) return false;
  page.insertBefore(el, tail);
  return true;
}
function syncCollapseAll(page, v) {
  const btn = page.querySelector(':scope > .toolbar [data-act="collapse-all"], :scope > .toolbar [data-act="expand-all"]');
  if (!btn) return false;
  const html = collapseAllHtml(v);
  if (!html.includes(`data-act="${btn.getAttribute("data-act")}"`)) replaceWith(btn, html);
  return true;
}
function patch(fn) {
  const v = S.view;
  const page = need("#main").querySelector(":scope > .page");
  const ok = !!v && !S.page && v.wtId === curWt()?.id && !!page?.querySelector(":scope > .toolbar") && fn(page, v, commentsByAnchor(v.comments)) && syncOrphan(page, v) && syncCollapseAll(page, v);
  if (!ok) renderMain();
}
var fileEl = (f) => document.getElementById(`f-${fnv(f.uid)}`);
var groupEl = (n) => document.getElementById(`cg-${n}`);
function patchFiles(files, byAnchor2) {
  for (const f of files) {
    const el = fileEl(f);
    if (!el) return false;
    replaceWith(el, renderFile(f, byAnchor2));
  }
  return true;
}
function patchGroups(groups, byAnchor2) {
  for (const g of groups) {
    const el = groupEl(g.n);
    if (!el) return false;
    replaceWith(el, groupHtml(g, byAnchor2));
  }
  return true;
}
function redrawFile(f) {
  patch((_page, _v, byAnchor2) => patchFiles([f], byAnchor2));
}
function toggleFile(f) {
  S.toggled.set(f.uid, !isCollapsed(f));
  patch((_page, _v, byAnchor2) => patchFiles([f], byAnchor2));
}
function toggleCommit(n) {
  if (S.shutCommits.has(n)) S.shutCommits.delete(n);
  else S.shutCommits.add(n);
  patch((_page, v, byAnchor2) => patchGroups((v.groups ?? []).filter((g) => g.n === n), byAnchor2));
}
function toggleBody(n) {
  if (S.openBodies.has(n)) S.openBodies.delete(n);
  else S.openBodies.add(n);
  patch((_page, v) => {
    const g = v.groups?.find((x) => x.n === n);
    const el = groupEl(n)?.querySelector(":scope > .commit-body");
    if (!g?.body || !el) return false;
    replaceWith(el, commitBodyHtml(g.body, n));
    return true;
  });
}
function collapseAll(v) {
  if (v.diff.mode === "commits") {
    const groups = (v.groups ?? []).filter((g) => !S.shutCommits.has(g.n));
    for (const g of groups) S.shutCommits.add(g.n);
    patch((_page, _v, byAnchor2) => patchGroups(groups, byAnchor2));
  } else {
    const files = v.files.filter((f) => !isCollapsed(f));
    for (const f of v.files) S.toggled.set(f.uid, true);
    patch((_page, _v, byAnchor2) => patchFiles(files, byAnchor2));
  }
}
function expandAll(v) {
  const groups = (v.groups ?? []).filter((g) => S.shutCommits.has(g.n));
  S.shutCommits.clear();
  patch((_page, _v, byAnchor2) => patchGroups(groups, byAnchor2));
}

// src/web/picker.ts
var FOLDER_ICON = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z"/></svg>';
var REPO_ICON = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z"/></svg>';
async function openPicker(p) {
  const picker = S.picker ||= { hidden: false };
  try {
    picker.data = await api("GET", `/api/fs?path=${encodeURIComponent(p)}${picker.hidden ? "&hidden=1" : ""}`);
  } catch (e) {
    toast(errMsg(e), true);
    if (picker.data) return;
    picker.data = null;
    return;
  }
  renderPicker();
}
function closePicker() {
  $("#picker")?.remove();
}
function renderPicker() {
  const picker = S.picker;
  const d = picker?.data;
  if (!picker || !d) return;
  const home = st().home;
  const parts = d.display.split("/").filter(Boolean);
  const crumbs = parts.map((name, i) => {
    const target = i === 0 ? home : `${home}/${parts.slice(1, i + 1).join("/")}`;
    return i === parts.length - 1 ? `<strong>${esc(name)}</strong>` : `<button class="link-btn" data-act="picker-go" data-path="${esc(target)}">${esc(name)}</button>`;
  }).join('<span class="muted">/</span>');
  const added = [...st().config.roots, ...st().config.extraRepos].map(expandHome);
  const already = added.includes(d.path);
  const verdict = d.isRepo ? `<strong>${esc(d.display)}</strong> is a git repo. Its worktrees will be listed.` : d.repoChildren ? `<strong>${esc(d.display)}</strong> contains ${d.repoChildren} git repo${d.repoChildren === 1 ? "" : "s"}. All of them, and their worktrees, will be listed.` : `No git repos directly inside <strong>${esc(d.display)}</strong>. Open a folder that has some, or pick a repo.`;
  let el = $("#picker");
  if (!el) {
    const made = document.createElement("div");
    made.id = "picker";
    made.className = "modal-backdrop";
    made.addEventListener("click", (e) => {
      if (e.target === made) closePicker();
    });
    document.body.appendChild(made);
    el = made;
  }
  el.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="Choose a folder">
    <div class="modal-head"><span>Choose a folder</span><button class="link-btn" data-act="picker-close" aria-label="Close">✕</button></div>
    <div class="crumbs">${d.parent ? `<button class="btn small" data-act="picker-go" data-path="${esc(d.parent)}" title="Up one level">↑</button>` : ""}${crumbs}</div>
    <div class="dir-list">${d.entries.length ? d.entries.map((e) => `
      <button class="dir ${e.isRepo ? "repo" : ""}" data-act="picker-go" data-path="${esc(e.path)}">
        ${e.isRepo ? REPO_ICON : FOLDER_ICON}<span class="dir-name">${esc(e.name)}</span>${e.isRepo ? '<span class="chip open">git repo</span>' : ""}${added.includes(e.path) ? '<span class="chip">added</span>' : ""}
      </button>`).join("") : '<div class="file-note">No folders here.</div>'}</div>
    <div class="modal-foot">
      <div class="verdict">${verdict}</div>
      <div class="actions">
        <label class="toggle small"><input type="checkbox" data-act="picker-hidden" ${picker.hidden ? "checked" : ""}> Show hidden</label>
        <span style="flex:1"></span>
        <button class="btn" data-act="picker-close">Cancel</button>
        <button class="btn primary" data-act="picker-add" ${already || !d.isRepo && !d.repoChildren ? "disabled" : ""}>${already ? "Already added" : d.isRepo ? "Add this repo" : "Add this folder"}</button>
      </div>
    </div>
  </div>`;
  const list = el.querySelector(".dir-list");
  if (list) list.scrollTop = 0;
}

// src/web/result.ts
function showResult({ title, busy, ok = [], okLabel, failed = [], failedLabel, note }) {
  let el = $("#result");
  if (!el) {
    const made = document.createElement("div");
    made.id = "result";
    made.className = "modal-backdrop";
    made.addEventListener("click", (e) => {
      if (e.target === made && !made.dataset.busy) closeResult();
    });
    document.body.appendChild(made);
    el = made;
  }
  el.dataset.busy = busy ? "1" : "";
  const item = (x, bad) => `<div class="result-item ${bad ? "bad" : ""}">
      <div><strong>${esc(x.branch || tilde(x.path))}</strong> <span class="muted mono">${esc(tilde(x.path))}</span></div>
      ${bad ? `<div class="result-err">${esc(x.error)}</div><button class="link-btn" data-act="result-open" data-id="${esc(x.id)}">Open this worktree</button>` : ""}
    </div>`;
  el.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="modal-head"><span>${esc(title)}</span>${busy ? "" : '<button class="link-btn" data-act="close-result" aria-label="Close">✕</button>'}</div>
    <div class="dir-list result-list">
      ${busy ? '<div class="file-note">Working… removing a worktree can take a few seconds each.</div>' : `
        ${failed.length ? `<h3 class="result-h bad">${failedLabel} (${failed.length})</h3>${failed.map((x) => item(x, true)).join("")}` : ""}
        ${ok.length ? `<h3 class="result-h">${okLabel} (${ok.length})</h3>${ok.map((x) => item(x, false)).join("")}` : ""}
        ${!ok.length && !failed.length ? '<div class="file-note">Nothing to do.</div>' : ""}
        ${note ? `<p class="muted small">${esc(note)}</p>` : ""}`}
    </div>
    ${busy ? "" : '<div class="modal-foot"><div class="actions" style="justify-content:flex-end"><button class="btn" data-act="close-result">Close</button></div></div>'}
  </div>`;
}
function closeResult() {
  $("#result")?.remove();
}

// src/web/actions.ts
var attr = (el, name) => el.dataset[name] ?? "";
var isChecked = (el) => el instanceof HTMLInputElement && el.checked;
function lineTextFor(key) {
  const { commit, file, side, line } = parseKey(key);
  const f = view().files.find((x) => x.path === file && sameCommit(x.commit, commit));
  for (const h of f?.hunks || []) for (const l of h.lines) {
    if ((side === "old" ? l.o : l.n) === Number(line) && side === "old" === (l.t === "del")) return l.text;
  }
  return "";
}
async function saveEditor(ek) {
  const text = (S.editors.get(ek) || "").trim();
  if (!text) return;
  const [kind, rest] = [ek.slice(0, ek.indexOf(":")), ek.slice(ek.indexOf(":") + 1)];
  if (kind === "new") {
    const { commit, file, side, line } = parseKey(rest);
    const c = commit && view().diff.commits.find((x) => x.sha === commit);
    await api("POST", "/api/comments", { wtId: view().wtId, file, side, line, lineText: lineTextFor(rest), body: text, commit: commit || void 0, commitSubject: c ? c.subject : void 0 });
  } else if (kind === "edit") {
    await api("PATCH", `/api/comments/${rest}`, { body: text });
  } else if (kind === "reply") {
    await api("POST", `/api/comments/${rest}/reply`, { body: text, author: "you" });
  }
  S.editors.delete(ek);
  await reloadComments();
}
var actions = {
  "new-comment": (el) => {
    const ek = `new:${attr(el, "k")}`;
    if (!S.editors.has(ek)) S.editors.set(ek, "");
    S.focusEk = ek;
    renderMain();
  },
  "cancel-editor": (el) => {
    S.editors.delete(attr(el, "ek"));
    renderMain();
  },
  "save-editor": (el) => saveEditor(attr(el, "ek")),
  edit: (el) => {
    const c = view().comments.find((x) => x.id === attr(el, "id"));
    if (!c) return;
    S.editors.set(`edit:${c.id}`, c.body);
    S.focusEk = `edit:${c.id}`;
    renderMain();
  },
  reply: (el) => {
    S.editors.set(`reply:${attr(el, "id")}`, "");
    S.focusEk = `reply:${attr(el, "id")}`;
    renderMain();
  },
  delete: async (el) => {
    await api("DELETE", `/api/comments/${attr(el, "id")}`);
    await reloadComments();
  },
  resolve: async (el) => {
    await api("POST", `/api/comments/${attr(el, "id")}/resolve`, { author: "you" });
    await reloadComments();
  },
  reopen: async (el) => {
    await api("POST", `/api/comments/${attr(el, "id")}/reopen`);
    await reloadComments();
  },
  "blame-file": async (el) => {
    const v = view();
    const f = v.files.find((x) => x.uid === attr(el, "file"));
    if (!f) return;
    if (S.blameOn.has(f.uid)) {
      S.blameOn.delete(f.uid);
      redrawFile(f);
      return;
    }
    const key = blameKey(f);
    if (!S.fileBlame.has(key)) {
      el.disabled = true;
      el.textContent = "Blame…";
      try {
        S.fileBlame.set(key, await api("GET", `/api/worktrees/${v.wtId}/blame/file?path=${encodeURIComponent(f.path)}`));
      } catch (e) {
        toast(errMsg(e), true);
        redrawFile(f);
        return;
      }
      if (S.view !== v) return;
    }
    S.blameOn.add(f.uid);
    redrawFile(f);
  },
  "toggle-file": (el) => {
    const f = view().files.find((x) => x.uid === attr(el, "file"));
    if (f) toggleFile(f);
  },
  "collapse-all": () => collapseAll(view()),
  "expand-all": () => expandAll(view()),
  "toggle-body": (el) => toggleBody(Number(attr(el, "n"))),
  "toggle-commit": (el) => {
    const n = Number(attr(el, "n"));
    toggleCommit(n);
    document.getElementById(`cg-${n}`)?.scrollIntoView({ block: "nearest" });
  },
  "hl-commit": (el, e) => {
    e.preventDefault();
    const n = el.dataset.n === "" ? null : Number(el.dataset.n);
    S.hl = S.hl === n ? null : n;
    const hl2 = S.hl;
    if (hl2 !== null) {
      for (const f of view().files) if (fileCommitsOf(f.path).includes(hl2)) S.toggled.set(f.uid, false);
    }
    renderMain();
  },
  "view-commit": (el, e) => {
    e.preventDefault();
    S.scrollTo = `cg-${attr(el, "n")}`;
    S.shutCommits.delete(Number(attr(el, "n")));
    if (view().diff.mode === "commits") {
      renderMain();
      return;
    }
    S.mode = "commits";
    S.hl = null;
    loadView();
  },
  "force-render": (el) => {
    S.forceRender.add(attr(el, "file"));
    renderMain();
  },
  viewed: async (el) => {
    const f = view().files.find((x) => x.path === attr(el, "file"));
    if (!f) return;
    const on = isChecked(el);
    await api("POST", `/api/worktrees/${view().wtId}/viewed`, { file: f.path, hash: f.hash, viewed: on });
    if (on) view().diff.viewed[f.path] = f.hash;
    else delete view().diff.viewed[f.path];
    S.toggled.delete(f.uid);
    renderMain();
  },
  jump: (el, e) => {
    e.preventDefault();
    const f = view().files.find((x) => x.path === attr(el, "file") && !x.commit);
    if (!f) return;
    if (isCollapsed(f)) {
      S.toggled.set(f.uid, false);
      renderMain();
    }
    document.getElementById(`f-${fnv(f.uid)}`)?.scrollIntoView({ block: "start" });
  },
  mode: (el, e) => {
    e.preventDefault();
    const m = el.dataset.mode;
    if (m === "full" || m === "since" || m === "commits") S.mode = m;
    S.hl = null;
    loadView();
  },
  refresh: () => {
    loadView();
  },
  "mark-reviewed": async () => {
    const v = view();
    await api("POST", `/api/worktrees/${v.wtId}/reviewed`, { tree: v.diff.tree, fingerprint: v.diff.fingerprint });
    toast("Marked as reviewed. Next time you'll see only what changed.");
    S.mode = "since";
    loadView();
  },
  "set-base": async () => {
    try {
      await api("POST", `/api/worktrees/${S.selId}/base`, { base: need("#base").value.trim() });
      S.baseOther = null;
      S.view = null;
      loadView();
    } catch (e) {
      toast(errMsg(e), true);
    }
  },
  "base-other-cancel": () => {
    S.baseOther = null;
    redrawHeaderMeta();
  },
  "reset-base": async () => {
    await api("POST", `/api/worktrees/${S.selId}/base`, { base: "" });
    S.view = null;
    loadView();
  },
  "copy-path": async () => {
    const wt = curWt();
    if (wt) await copy(wt.path, "Path copied");
  },
  "copy-prompt": async () => {
    const { text } = await api("GET", `/api/worktrees/${S.selId}/prompt`);
    await copy(text, "Review copied as a prompt");
  },
  submit: async () => {
    const wt = curWt();
    if (!wt) return;
    const target = S.summaries[`${wt.id}:target`] || null;
    const review = await api("POST", `/api/worktrees/${wt.id}/submit`, { summary: S.summaries[wt.id] || "", targetSession: target });
    S.summaries[wt.id] = "";
    S.editors.delete("summary");
    const to = target ? st().sessions.filter((s) => s.sessionId === target) : wt.sessions;
    toast(review.status === "delivered" ? `Sent to ${review.deliveredTo?.name || "Claude"}, which is starting on it now.` : !to.length ? "Queued for the next Claude session that works here." : to.some((s) => s.status === "busy") ? "Sent. Claude gets it at the end of its current turn." : `Queued. ${to.map((s) => s.name).join(", ")} ${to.length === 1 ? "is" : "are"} idle, so Claude gets it with your next message there.`);
    await reloadComments();
  },
  "cancel-review": async (el) => {
    await api("POST", `/api/reviews/${attr(el, "id")}/cancel`);
    await reloadComments();
  },
  remove: async () => {
    const wt = curWt();
    if (!wt) return;
    const msg = wt.cleanup?.kind === "idle" ? `Remove this worktree?

Its folder is deleted. ${wt.branch ? `The branch ${wt.branch} is kept, so its commits are safe` : "Its commit is on a branch, so nothing is lost"}, and you can restore it from Cleaned up.` : "Remove this worktree? Its branch is deleted too if it matches the merged PR.";
    if (!confirm(msg)) return;
    if (S.selId) delete S.removeErrors[S.selId];
    await api("POST", `/api/worktrees/${S.selId}/remove`);
  },
  "remove-anyway": async () => {
    const wt = curWt();
    const cs = wt?.cleanup;
    if (!wt || !cs) return;
    const lost = cs.dirty ? cs.dirty.files.map((f) => `  • ${f.file}`).join("\n") + (cs.dirty.count > cs.dirty.files.length ? `
  …and ${cs.dirty.count - cs.dirty.files.length} more` : "") : "";
    const comments = wt.comments.draft + wt.comments.waiting;
    const msg = [
      `Remove ${wt.branch || "this worktree"} anyway?`,
      "",
      lost ? `These uncommitted changes will be lost:
${lost}` : "",
      comments ? `${comments} unsent review comment${comments === 1 ? "" : "s"} will stay in the dashboard's history but can't be delivered.` : "",
      "",
      wt.branch ? `The branch ${wt.branch} is kept, so its commits are safe.` : ""
    ].filter((l, i, a) => l || a[i - 1]).join("\n");
    if (!confirm(msg)) return;
    delete S.removeErrors[wt.id];
    await api("POST", `/api/worktrees/${wt.id}/remove`, { force: true });
  },
  "cleanup-safe": async () => {
    const n = st().worktrees.filter((w) => w.cleanup?.kind === "merged" && w.cleanup.eligible).length;
    if (!confirm(`Remove ${n} merged worktree${n === 1 ? "" : "s"} that are clean and not in use? This runs in the background.`)) return;
    await api("POST", "/api/cleanup/safe");
  },
  "clean-pick": (el) => {
    S.cleanSel.set(attr(el, "id"), isChecked(el));
    renderMain();
  },
  "clean-all": (el) => {
    for (const w of cleanupGroups().ready) S.cleanSel.set(w.id, attr(el, "on") === "1");
    renderMain();
  },
  "clean-run": async () => {
    const ids = cleanupGroups().ready.filter((w) => cleanPicked(w)).map((w) => w.id);
    if (!ids.length) return;
    const merged = ids.filter((id) => st().worktrees.find((w) => w.id === id)?.cleanup?.branchSafe).length;
    const msg = `Remove ${ids.length} worktree${ids.length === 1 ? "" : "s"}?

Their folders are deleted. ${merged ? `${merged} merged branch${merged === 1 ? " is" : "es are"} deleted too, because everything on ${merged === 1 ? "it is" : "them is"} in the merged PR. ` : ""}Every other branch is kept, and each removal can be restored from Cleaned up. This runs in the background.`;
    if (!confirm(msg)) return;
    await api("POST", "/api/cleanup", { ids });
    for (const id of ids) S.cleanSel.delete(id);
  },
  "job-dismiss": async (el) => {
    await api("POST", `/api/jobs/${attr(el, "id")}/dismiss`);
  },
  "job-details": (el) => {
    const j = st().jobs.find((x) => x.id === attr(el, "id"));
    if (!j) return;
    const verb = j.kind === "repair" ? "Repaired" : "Removed";
    showResult({ title: j.title, ok: j.ok, okLabel: verb, failed: j.failed, failedLabel: j.kind === "repair" ? "Couldn't repair" : "Couldn't remove" });
  },
  repair: async () => {
    const r = await api("POST", `/api/worktrees/${S.selId}/repair`);
    if (r.failed.length && S.selId) {
      S.removeErrors[S.selId] = `Repair didn't work: ${r.failed[0]?.error}`;
      renderMain();
    } else {
      if (S.selId) delete S.removeErrors[S.selId];
      toast("Link repaired");
      S.view = null;
      loadView();
    }
  },
  "repair-all": async () => {
    const n = st().worktrees.filter((w) => w.error?.kind === "broken-link").length;
    if (!confirm(`Repair the links for ${n} worktree${n === 1 ? "" : "s"}? This runs "git worktree repair" in each repository, which rewrites the link files for all of that repository's worktrees; your code isn't touched.`)) return;
    toast(`Repairing ${n} worktree link${n === 1 ? "" : "s"}…`);
    const r = await api("POST", "/api/repair");
    if (!r.failed.length) {
      toast(`Repaired ${r.fixed.length} worktree link${r.fixed.length === 1 ? "" : "s"}`);
      return;
    }
    showResult({
      title: "Repair worktree links",
      ok: r.fixed,
      okLabel: "Repaired",
      failed: r.failed,
      failedLabel: "Couldn't repair",
      note: r.fixed.length ? "Repaired worktrees are checked again now. Clean, merged ones become removable within a few seconds." : ""
    });
  },
  "close-result": () => closeResult(),
  "result-open": (el) => {
    closeResult();
    location.hash = `#/${attr(el, "id")}`;
  },
  "auto-cleanup": async (el) => {
    await api("POST", "/api/config", { autoCleanup: isChecked(el) });
  },
  "toggle-older": () => {
    S.showOlder = !S.showOlder;
    renderSidebar();
  },
  "toggle-cleaned": () => {
    S.showCleaned = !S.showCleaned;
    renderSidebar();
  },
  "review-menu": () => {
    S.reviewMenu = S.reviewMenu === S.selId ? null : S.selId;
    if (S.reviewMenu && S.reviewPick) S.reviewPick = { ...S.reviewPick, effort: null };
    renderMain();
  },
  "review-start": async () => {
    const wt = curWt();
    if (!wt) return;
    const { reviewer, effort } = reviewPick(wt);
    const body = reviewer === "claude" ? { reviewer, effort } : { reviewer };
    const r = await api("POST", `/api/worktrees/${wt.id}/code-review`, body);
    S.reviewMenu = null;
    (view().codeReviews ??= {})[reviewer] = r;
    indexFindings();
    toast(reviewer === "coderabbit" ? "CodeRabbit started. This usually takes a few minutes." : `Claude started a ${effort}-effort review.`);
    renderMain();
  },
  "review-cancel": async (el) => {
    const reviewer = attr(el, "reviewer");
    if (!confirm(`Cancel this ${NAMES[reviewer]} review? Its progress is thrown away.`)) return;
    await api("POST", `/api/worktrees/${S.selId}/code-review/${reviewer}/cancel`);
  },
  "cr-send": async (el) => {
    await api("POST", `/api/findings/${attr(el, "id")}/send`);
    await loadCodeReviews();
    await reloadComments();
  },
  "cr-dismiss": async (el) => {
    await api("POST", `/api/findings/${attr(el, "id")}/dismiss`);
    await loadCodeReviews();
    renderMain();
  },
  "cr-restore": async (el) => {
    await api("POST", `/api/findings/${attr(el, "id")}/restore`);
    await loadCodeReviews();
    renderMain();
  },
  "cr-send-all": async (el) => {
    const { sent } = await api("POST", `/api/worktrees/${S.selId}/code-review/${attr(el, "reviewer")}/send-all`);
    toast(`Added ${sent} finding${sent === 1 ? "" : "s"} to your review as drafts`);
    await loadCodeReviews();
    await reloadComments();
  },
  "cr-jump": (el, e) => {
    e.preventDefault();
    const f = view().files.find((x) => x.path === attr(el, "file") && !x.commit);
    if (!f) {
      toast("That file isn't in this diff view");
      return;
    }
    if (isCollapsed(f)) {
      S.toggled.set(f.uid, false);
      renderMain();
    }
    fillFile(f.path);
    const row = document.querySelector(`tr.line[data-k="${CSS.escape(keyOf(f.path, "new", el.dataset.line))}"]`);
    (row || document.getElementById(`f-${fnv(f.path)}`))?.scrollIntoView({ block: "center" });
  },
  recheck: () => {
    S.integ = null;
    renderMain();
    return loadIntegrations(true);
  },
  "copy-text": (el) => copy(attr(el, "text")),
  "cr-login": async () => {
    await api("POST", "/api/integrations/coderabbit/login");
  },
  "cr-logout": async () => {
    if (!confirm("Sign out of the CodeRabbit CLI on this machine?")) return;
    S.integ = await api("POST", "/api/integrations/coderabbit/logout");
    renderMain();
  },
  "open-picker": () => openPicker(S.picker?.data?.path || "~"),
  "picker-go": (el) => openPicker(attr(el, "path")),
  "picker-hidden": (el) => {
    const p = S.picker;
    if (!p?.data) return;
    p.hidden = isChecked(el);
    openPicker(p.data.path);
  },
  "picker-close": () => closePicker(),
  "picker-add": async () => {
    const d = S.picker?.data;
    if (!d) return;
    const key = d.isRepo ? "extraRepos" : "roots";
    if (st().config[key].map(expandHome).includes(d.path)) {
      toast("Already added");
      return;
    }
    await saveConfig({ [key]: [...st().config[key], d.path] });
    closePicker();
  },
  "remove-folder": (el) => {
    const key = el.dataset.key;
    if (key !== "roots" && key !== "extraRepos") return;
    return saveConfig({ [key]: st().config[key].filter((p) => p !== el.dataset.path) });
  },
  "enable-notifications": () => Notification.requestPermission().then(() => {
    need("#notify").hidden = true;
    renderMain();
  }),
  "rerun-setup": async () => {
    await api("POST", "/api/onboarding", { done: false });
    location.hash = "#/welcome";
  },
  "finish-setup": async () => {
    await api("POST", "/api/onboarding", { done: true });
    const first = defaultWorktree(st().worktrees);
    location.hash = first ? `#/${first.id}` : "#/";
  },
  "copy-restore": (el) => {
    const c = st().cleaned[Number(el.dataset.i)];
    if (!c) return;
    const cmd2 = !c.branch ? `git -C ${c.repoRoot} worktree add --detach ${c.path} ${c.sha}` : c.branchDeleted ? `git -C ${c.repoRoot} worktree add -b ${c.branch} ${c.path} ${c.sha}` : `git -C ${c.repoRoot} worktree add ${c.path} ${c.branch}`;
    copy(cmd2, "Restore command copied");
  }
};

// src/web/live.ts
function maybeNotify(st2) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  for (const s of st2.sessions) {
    const prev = S.prevStatus.get(s.sessionId);
    if (prev === "busy" && s.status === "idle") {
      const wts = st2.worktrees.filter((w) => w.review.needsReview && w.sessions.some((x) => x.sessionId === s.sessionId));
      const first = wts[0];
      if (!first) continue;
      const n = new Notification(`${s.name} finished`, { body: `Ready to review: ${wts.map((w) => w.branch || w.path).join(", ")}`, tag: s.sessionId });
      n.onclick = () => {
        window.focus();
        location.hash = `#/${first.id}`;
      };
    }
  }
  S.prevStatus = new Map(st2.sessions.map((s) => [s.sessionId, s.status]));
  for (const w of st2.worktrees) {
    for (const k of REVIEWERS) {
      const r = w.codeReviews[k];
      if (S.prevCr?.get(`${w.id} ${k}`) === "running" && r && r.status !== "running") {
        const n = new Notification(`${NAMES[k]} finished reviewing ${w.branch || "a worktree"}`, { body: r.total ? `${r.total} finding${r.total === 1 ? "" : "s"}` : "No findings", tag: `cr-${w.id}-${k}` });
        n.onclick = () => {
          window.focus();
          location.hash = `#/${w.id}`;
        };
      }
    }
  }
  S.prevCr = new Map(st2.worktrees.flatMap((w) => REVIEWERS.map((k) => [`${w.id} ${k}`, w.codeReviews[k]?.status])));
}
function onState(st2) {
  if (S.st && st2.version !== S.st.version) {
    location.reload();
    return;
  }
  const first = !S.st;
  maybeNotify(st2);
  S.st = st2;
  renderSidebar();
  const wt = curWt();
  if (first) {
    if (!st2.onboardedAt && location.hash !== "#/welcome") location.hash = "#/welcome";
    else onHash();
    return;
  }
  if (S.page) {
    const sig = setupSig(st2);
    if (sig === S.setupSig) return;
    const prevSig = S.setupSig ? JSON.parse(S.setupSig) : null;
    const loginFinished = prevSig?.[0]?.running && !st2.coderabbitLogin?.running;
    S.setupSig = sig;
    if (loginFinished) loadIntegrations(true);
    else if (S.page === "cleanup" || !document.activeElement?.matches("input, select, textarea")) renderMain();
    return;
  }
  const v = S.view;
  if (!wt || !v || v.wtId !== wt.id) {
    renderMain();
    return;
  }
  if (wt.fingerprint !== v.diff.fingerprint) {
    const typing = [...S.editors.entries()].some(([k, val]) => k !== "summary" && val !== void 0);
    if (typing) {
      S.stale = true;
      renderMain();
    } else loadView({ quiet: true });
  } else if (reviewsSig(wt) !== v.crSig) {
    const was = REVIEWERS.map((k) => v.codeReviews?.[k]?.status);
    v.crSig = reviewsSig(wt);
    loadCodeReviews().then(() => {
      const cur = S.view;
      if (!cur) return;
      REVIEWERS.forEach((k, i) => {
        const r = cur.codeReviews?.[k];
        if (was[i] !== "running" || !r || r.status === "running") return;
        const n = r.findings.length;
        toast(r.status === "done" ? `${NAMES[k]} finished: ${n ? `${n} finding${n === 1 ? "" : "s"}` : "no findings"}` : `${NAMES[k]} review stopped`, r.status === "failed");
      });
      if (wt.comments.sig !== cur.commentSig) {
        cur.commentSig = wt.comments.sig;
        reloadComments();
      } else renderMain();
    });
  } else if (wt.comments.sig !== v.commentSig) {
    v.commentSig = wt.comments.sig;
    reloadComments();
  } else if (headerSig(wt) !== v.headerSig && !document.activeElement?.matches("textarea, input")) {
    renderMain();
  }
}
function onLiveMessage(msg) {
  if (msg.type === "state") {
    const st2 = JSON.parse(msg.data);
    need("#conn").textContent = `v${st2.version}`;
    need("#conn").className = "brand-sub";
    onState(st2);
  } else {
    need("#conn").textContent = "server not running — retrying";
    need("#conn").className = "brand-sub down";
  }
}
function connect() {
  if ("SharedWorker" in window) {
    try {
      const worker = new SharedWorker("/sse-worker.js", { name: "worktree-review-live" });
      worker.port.onmessage = (e) => onLiveMessage(e.data);
      worker.port.start();
      window.addEventListener("pagehide", () => worker.port.postMessage("close"));
      return;
    } catch {
    }
  }
  const es = new EventSource("/api/events");
  es.addEventListener("state", (e) => {
    if (e instanceof MessageEvent) onLiveMessage({ type: "state", data: String(e.data) });
  });
  es.onerror = () => onLiveMessage({ type: "error" });
}

// src/web/app.ts
var valueOf = (el) => el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement ? el.value : "";
setInterval(() => {
  for (const el of document.querySelectorAll(".cr-elapsed, .tick")) el.textContent = elapsed(Number(el.dataset.start));
}, 1e3);
document.addEventListener("click", (e) => {
  const target = e.target;
  if (!(target instanceof Element)) return;
  if (S.reviewMenu && !target.closest(".review-run")) {
    S.reviewMenu = null;
    renderMain();
  }
  const el = target.closest("[data-act]");
  if (!el || el.tagName === "SELECT" || el instanceof HTMLInputElement && el.type === "checkbox" && e.type === "click" && !["viewed", "auto-cleanup", "picker-hidden", "clean-pick"].includes(el.dataset.act ?? "")) return;
  const fn = actions[el.dataset.act ?? ""];
  if (!fn) return;
  if (el.tagName === "A") e.preventDefault();
  Promise.resolve(fn(el, e)).catch((err) => toast(errMsg(err), true));
});
document.addEventListener("change", (e) => {
  const el = e.target;
  if (!(el instanceof HTMLElement)) return;
  if (el.dataset.act === "target") S.summaries[`${S.selId}:target`] = valueOf(el);
  if (el.dataset.act === "base-select") chooseBase(valueOf(el));
  if (el.dataset.review) {
    const wt = curWt();
    if (!wt) return;
    const pick = reviewPick(wt);
    S.reviewPick = el.dataset.review === "reviewer" ? { ...pick, reviewer: valueOf(el) } : { ...pick, effort: valueOf(el) };
    renderMain();
  }
  if (el.dataset.cfg) {
    const key = el.dataset.cfg;
    const value = el instanceof HTMLInputElement && el.type === "checkbox" ? el.checked : el instanceof HTMLInputElement && el.type === "number" ? Number(el.value) : valueOf(el);
    saveConfig({ [key]: value });
  }
});
document.addEventListener("input", (e) => {
  const el = e.target;
  if (!(el instanceof HTMLElement)) return;
  if (el.id === "filter") {
    S.filter = valueOf(el);
    renderSidebar();
    return;
  }
  const ek = el.dataset.ek;
  if (!ek) return;
  if (ek === "summary") {
    S.summaries[S.selId ?? ""] = valueOf(el);
    const btn = $('[data-act="submit"]');
    if (btn) btn.disabled = !valueOf(el).trim() && !view().comments.some((c) => c.status === "draft");
  } else S.editors.set(ek, valueOf(el));
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && $("#picker")) {
    closePicker();
    return;
  }
  if (e.key === "Escape" && $("#result") && !$("#result")?.dataset.busy) {
    closeResult();
    return;
  }
  if (e.key === "Escape" && S.reviewMenu) {
    S.reviewMenu = null;
    renderMain();
    return;
  }
  const el = e.target;
  if (!(el instanceof HTMLElement)) return;
  if (el.dataset.act === "base-input") {
    if (e.key === "Enter") {
      e.preventDefault();
      need('[data-act="set-base"]').click();
    }
    if (e.key === "Escape") {
      S.baseOther = null;
      redrawHeaderMeta();
    }
    return;
  }
  const ek = el.dataset.ek;
  if (!ek || ek === "summary") return;
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    saveEditor(ek).catch((err) => toast(errMsg(err), true));
  }
  if (e.key === "Escape") {
    S.editors.delete(ek);
    renderMain();
  }
});
window.addEventListener("hashchange", onHash);
var nb = need("#notify");
if ("Notification" in window && Notification.permission === "default") {
  nb.hidden = false;
  nb.onclick = () => Notification.requestPermission().then(() => {
    nb.hidden = true;
  });
}
connect();
