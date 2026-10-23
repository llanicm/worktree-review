// ---------- settings & onboarding ----------
import type { Integrations, PublicState } from '../shared/api.ts';
import { renderMain } from './view.ts';
import { api, errMsg, S, st } from './state.ts';
import type { Page } from './types.ts';
import { ago, esc, expandHome, tilde, toast } from './util.ts';

const ICON_OK = '<span class="check ok" aria-label="Done">✓</span>';
const ICON_TODO = '<span class="check todo" aria-label="Needs attention">!</span>';
const ICON_OPT = '<span class="check opt" aria-label="Optional">–</span>';
const ICON_WAIT = '<span class="check wait" aria-label="Checking">…</span>';

export async function loadIntegrations(refresh = false) {
  try {
    S.integ = await api<Integrations>('GET', `/api/integrations${refresh ? '?refresh=1' : ''}`);
  } catch (e) { toast(errMsg(e), true); }
  if (S.page) renderMain();
}

function stepHtml(icon: string, title: string, body: string, extra = '') {
  return `<section class="step"><div class="step-icon">${icon}</div><div class="step-main"><h2>${title}</h2>${body}${extra}</div></section>`;
}

const cmd = (c: string) => `<code class="cmd">${esc(c)}</code><button class="link-btn" data-act="copy-text" data-text="${esc(c)}">copy</button>`;

function foldersHtml() {
  const c = st().config;
  const row = (key: 'roots' | 'extraRepos', p: string) => `<div class="folder-row"><code title="${esc(expandHome(p))}">${esc(tilde(expandHome(p)))}</code><button class="link-btn" data-act="remove-folder" data-key="${key}" data-path="${esc(p)}">remove</button></div>`;
  return `<div class="folders">
    ${c.roots.map((p) => row('roots', p)).join('')}${c.extraRepos.map((p) => row('extraRepos', p)).join('')}
    <div class="folder-add">
      <button class="btn small" data-act="open-picker">Choose a folder…</button>
      <span class="muted small">A repo, or a folder of repos.</span>
    </div>
  </div>`;
}

const EFFORT_OPTIONS: [string, string][] = [['low', 'Low (quickest)'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max (most thorough)']];
const EDITOR_OPTIONS: [string, string][] = [['vscode', 'VS Code'], ['cursor', 'Cursor'], ['windsurf', 'Windsurf'], ['zed', 'Zed'], ['none', 'No editor links']];

export function setupHtml(mode: Page) {
  const state = st();
  const I = S.integ;
  const c = state.config;
  const welcome = mode === 'welcome';
  const steps: string[] = [];

  // 1. Worktrees
  const nRepos = state.repos.length;
  steps.push(stepHtml(state.worktrees.length ? ICON_OK : ICON_TODO, 'Your worktrees',
    `<p>${state.worktrees.length
      ? `Found <strong>${state.worktrees.length} worktree${state.worktrees.length === 1 ? '' : 's'}</strong> in ${nRepos} repo${nRepos === 1 ? '' : 's'}, from the folders your Claude Code sessions have worked in over the last 30 days.`
      : 'No worktrees yet. Repos appear here once a Claude Code session has worked in them, or add a folder below.'}</p>
     ${nRepos ? `<div class="repo-list">${state.repos.map((r) => `<div><strong>${esc(r.name)}</strong> <code>${esc(tilde(r.root))}</code>${r.github ? ` <span class="muted">${esc(r.github)}</span>` : ''}</div>`).join('')}</div>` : ''}
     <details ${welcome && state.worktrees.length ? '' : 'open'}><summary>Also scan these folders</summary>${foldersHtml()}</details>`));

  // 2. Claude Code
  const hookAgo = I?.claude.lastHookAt ? ago(I.claude.lastHookAt) : null;
  steps.push(stepHtml(!I ? ICON_WAIT : (state.sessions.length || hookAgo) ? ICON_OK : ICON_TODO, 'Claude Code',
    `<p>${state.sessions.length} live session${state.sessions.length === 1 ? '' : 's'}.
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
  const login = state.coderabbitLogin;
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
    const orgs = cr.orgs;
    crBody = `<table class="kv">
        <tr><td>Account</td><td><strong>${esc(cr.user)}</strong>${cr.email ? ` <span class="muted">${esc(cr.email)}</span>` : ''}</td></tr>
        <tr><td>Organization</td><td>${esc(cr.org || '—')}${orgs && orgs.length > 1 ? ` <span class="muted">(also: ${orgs.filter((o) => o !== cr.org).map(esc).join(', ')})</span>` : ''}</td></tr>
        ${cr.plan ? `<tr><td>Plan</td><td>${esc(cr.plan)}${cr.seat ? ` · seat ${esc(cr.seat)}` : ''}</td></tr>` : ''}
        <tr><td>CLI</td><td>${esc(cr.version || '')}</td></tr>
      </table>
      <p class="muted">Reviews count against the organization that owns each repo. To change your default organization, run ${cmd('coderabbit auth org')} in a terminal.</p>
      ${welcome ? '' : '<div class="actions"><button class="btn small" data-act="cr-logout">Sign out</button></div>'}`;
  }
  steps.push(stepHtml(crIcon, 'CodeRabbit <span class="muted small">optional</span>', crBody));

  // 5. Claude code review
  const cli = I?.claude.cliVersion;
  steps.push(stepHtml(!I ? ICON_WAIT : cli ? ICON_OK : ICON_OPT, 'Code review by Claude <span class="muted small">optional</span>', !I ? '<p class="muted">Checking…</p>'
    : cli ? `<p>Claude can review a worktree with Claude Code's built-in <code>/code-review</code> (claude ${esc(cli)}). It runs on this machine as a separate, read-only session and counts toward your Claude usage.</p>
      <label class="setting row"><span>Effort to start with</span>
        <select data-cfg="reviewEffort">${EFFORT_OPTIONS.map(([v, l]) => `<option value="${v}" ${c.reviewEffort === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <p class="muted">You can pick a different effort each time you run a review. Higher effort looks harder and takes longer.</p>`
    : `<p>The <code>claude</code> command wasn't found on this server's PATH, so Claude can't run code reviews here. Make sure it's on your PATH, then <button class="link-btn" data-act="recheck">check again</button>.</p>`));

  // 6. Preferences
  const notif = !('Notification' in window) ? 'unsupported' : Notification.permission;
  steps.push(stepHtml(ICON_OK, 'Preferences', `
    <label class="setting row"><span>Open files in</span>
      <select data-cfg="editor">${EDITOR_OPTIONS.map(([v, l]) => `<option value="${v}" ${c.editor === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <div class="setting row"><span>Desktop notifications when a session finishes work you haven't reviewed</span>
      ${notif === 'granted' ? '<span class="muted">On</span>' : notif === 'denied' ? '<span class="muted">Blocked in browser settings</span>' : notif === 'unsupported' ? '<span class="muted">Not supported here</span>' : '<button class="btn small" data-act="enable-notifications">Turn on</button>'}</div>
    ${welcome ? '' : `
    <label class="setting row"><span>Count a worktree as recent for</span><span><input type="number" min="1" max="90" data-cfg="recentDays" value="${c.recentDays}"> days</span></label>
    <label class="setting row"><span>Check PR status every</span><span><input type="number" min="1" max="60" data-cfg="prPollMinutes" value="${c.prPollMinutes}"> minutes</span></label>`}`));

  if (!welcome) {
    steps.push(stepHtml(ICON_OK, 'About', `<table class="kv">
      <tr><td>Version</td><td>${esc(state.version)}</td></tr>
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

export function setupSig(s: PublicState) {
  if (S.page === 'cleanup') return JSON.stringify([s.jobs, s.worktrees.map((w) => [w.id, w.cleanup, w.busy, w.sessions.length, w.pr?.state])]);
  return JSON.stringify([s.coderabbitLogin, s.config, s.repos, s.sessions.length, s.worktrees.length, s.onboardedAt]);
}

// The patch comes from a data-cfg attribute or the folder lists, so its keys are dynamic.
export async function saveConfig(patch: Record<string, unknown>) {
  try {
    await api('POST', '/api/config', patch);
    toast('Saved');
  } catch (e) { toast(errMsg(e), true); }
}
