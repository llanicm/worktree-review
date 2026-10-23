#!/usr/bin/env node
// Builds a self-contained demo of Worktree Review and starts a server on it, for screenshots
// and trying it out. Nothing outside the demo folder is read or changed: it runs with its own
// HOME (so its own ~/.claude), a made-up repo, and stand-ins for `gh`, `coderabbit` and `claude`.
//
//   node extras/demo/demo.mjs [folder]     (default: ./.demo; port: WTR_PORT or 4848)
//
// Stop it with: curl -X POST -H 'x-wtr: 1' localhost:4848/api/shutdown
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const DEMO = path.resolve(process.argv[2] || path.join(ROOT, '.demo'));
const PORT = Number(process.env.WTR_PORT || 4848);
const HOME = path.join(DEMO, 'home');
const BIN = path.join(DEMO, 'bin');
const CODE = path.join(HOME, 'code');
const REPO = path.join(CODE, 'shop');
const WTS = path.join(CODE, 'shop-worktrees');
const HOUR = 3600_000, DAY = 24 * HOUR;
const now = Date.now();

fs.rmSync(DEMO, { recursive: true, force: true });
fs.mkdirSync(REPO, { recursive: true });
fs.mkdirSync(BIN, { recursive: true });

// ---------- the repo ----------

let clock = now - 20 * DAY;
function git(cwd, args, at) {
  const d = new Date(at ?? clock).toISOString();
  const env = { ...process.env, HOME, GIT_AUTHOR_NAME: 'Sam Rivera', GIT_AUTHOR_EMAIL: 'sam@example.com', GIT_COMMITTER_NAME: 'Sam Rivera', GIT_COMMITTER_EMAIL: 'sam@example.com', GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d };
  return execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
}
function write(dir, files) {
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), text.replace(/^\n/, ''));
  }
}
function commit(dir, msg, files, at) {
  write(dir, files);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', msg], at);
  return git(dir, ['rev-parse', 'HEAD']);
}
function worktree(branch, dir, at) {
  git(REPO, ['worktree', 'add', '-q', '-b', branch, path.join(WTS, dir), 'main'], at);
  return path.join(WTS, dir);
}

git(REPO, ['init', '-q', '-b', 'main']);
git(REPO, ['remote', 'add', 'origin', 'git@github.com:acme/shop.git']);
commit(REPO, 'Initial shop: cart and checkout', {
  'README.md': '# shop\n\nA small storefront API.\n',
  '.gitignore': 'node_modules\n',
  'package.json': '{\n  "name": "shop",\n  "version": "1.4.0",\n  "type": "module",\n  "scripts": { "test": "node --test" }\n}\n',
  'package-lock.json': '{\n  "name": "shop",\n  "lockfileVersion": 3,\n  "packages": {}\n}\n',
  'src/cart.ts': `
export interface LineItem {
  sku: string;
  name: string;
  unitPrice: number; // in cents
  quantity: number;
}

export interface Cart {
  id: string;
  items: LineItem[];
}

export function subtotal(cart: Cart): number {
  return cart.items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
}

export function addItem(cart: Cart, item: LineItem): Cart {
  const existing = cart.items.find((i) => i.sku === item.sku);
  if (existing) {
    return { ...cart, items: cart.items.map((i) => (i.sku === item.sku ? { ...i, quantity: i.quantity + item.quantity } : i)) };
  }
  return { ...cart, items: [...cart.items, item] };
}
`,
  'src/checkout.ts': `
import { Cart, subtotal } from './cart.js';
import { taxFor } from './tax.js';

export interface Order {
  cartId: string;
  subtotal: number;
  tax: number;
  total: number;
}

export function checkout(cart: Cart, region: string): Order {
  if (!cart.items.length) throw new Error('Cart is empty');
  const sub = subtotal(cart);
  const tax = taxFor(sub, region);
  return { cartId: cart.id, subtotal: sub, tax, total: sub + tax };
}
`,
  'src/tax.ts': `
const RATES: Record<string, number> = { UK: 0.2, DE: 0.19, FR: 0.2, US: 0 };

export function taxFor(amount: number, region: string): number {
  return Math.round(amount * (RATES[region] ?? 0));
}
`,
  'src/api/client.ts': `
export async function get(path: string) {
  const res = await fetch(\`https://api.example.com\${path}\`);
  return res.json();
}
`,
});
git(REPO, ['update-ref', 'refs/remotes/origin/main', 'main']);

// 1. The one Claude is working on now: three commits plus uncommitted changes.
const disc = worktree('feat/checkout-discounts', 'checkout-discounts', now - 6 * HOUR);
commit(disc, 'Add discount codes', {
  'src/discounts.ts': `
export type Discount =
  | { code: string; kind: 'percent'; percent: number; expiresAt?: Date }
  | { code: string; kind: 'fixed'; amount: number; expiresAt?: Date };

const CODES: Discount[] = [
  { code: 'WELCOME10', kind: 'percent', percent: 10 },
  { code: 'SPRING5', kind: 'fixed', amount: 500, expiresAt: new Date('2026-06-01') },
];

export function findDiscount(code: string, at = new Date()): Discount | null {
  const d = CODES.find((c) => c.code === code.trim().toUpperCase());
  if (!d || (d.expiresAt && d.expiresAt < at)) return null;
  return d;
}

export function discountFor(amount: number, d: Discount): number {
  return d.kind === 'percent' ? Math.round((amount * d.percent) / 100) : Math.min(d.amount, amount);
}
`,
}, now - 5 * HOUR);
commit(disc, 'Apply discount codes at checkout\n\nThe discount comes off the subtotal before tax, so tax is charged on what the\ncustomer actually pays. An unknown or expired code is an error rather than being\nignored, so the customer is told.', {
  'src/checkout.ts': `
import { Cart, subtotal } from './cart.js';
import { taxFor } from './tax.js';
import { findDiscount, discountFor } from './discounts.js';

export interface Order {
  cartId: string;
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
}

export function checkout(cart: Cart, region: string, code?: string): Order {
  if (!cart.items.length) throw new Error('Cart is empty');
  const sub = subtotal(cart);
  let discount = 0;
  if (code) {
    const d = findDiscount(code);
    if (!d) throw new Error(\`Unknown or expired discount code: \${code}\`);
    discount = discountFor(sub, d);
  }
  const tax = taxFor(sub - discount, region);
  return { cartId: cart.id, subtotal: sub, discount, tax, total: sub - discount + tax };
}
`,
}, now - 4 * HOUR);
commit(disc, 'Test expired and fixed-amount codes', {
  'test/discounts.test.ts': `
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findDiscount, discountFor } from '../src/discounts.js';

test('codes are case-insensitive', () => {
  assert.equal(findDiscount(' welcome10 ')?.code, 'WELCOME10');
});

test('expired codes are not found', () => {
  assert.equal(findDiscount('SPRING5', new Date('2026-07-01')), null);
});

test('a fixed discount never exceeds the amount', () => {
  assert.equal(discountFor(300, { code: 'X', kind: 'fixed', amount: 500 }), 300);
});
`,
}, now - 3 * HOUR);
write(disc, {
  'src/checkout.ts': fs.readFileSync(path.join(disc, 'src/checkout.ts'), 'utf8')
    .replace("    if (!d) throw new Error(`Unknown or expired discount code: ${code}`);\n", "    if (!d) throw new DiscountError(code);\n")
    .replace("import { findDiscount, discountFor } from './discounts.js';\n", "import { findDiscount, discountFor } from './discounts.js';\n\nexport class DiscountError extends Error {\n  constructor(public code: string) {\n    super(`Unknown or expired discount code: ${code}`);\n  }\n}\n"),
});

// 2. A second session working in parallel.
const search = worktree('feat/search-filters', 'search-filters', now - 2 * DAY);
commit(search, 'Filter products by price range', {
  'src/search.ts': `
export interface Product { sku: string; name: string; price: number; tags: string[] }

export function byPrice(products: Product[], min = 0, max = Infinity): Product[] {
  return products.filter((p) => p.price >= min && p.price <= max);
}
`,
}, now - 50 * 60_000);
commit(search, 'Filter products by tag', {
  'src/search.ts': `
export interface Product { sku: string; name: string; price: number; tags: string[] }

export function byPrice(products: Product[], min = 0, max = Infinity): Product[] {
  return products.filter((p) => p.price >= min && p.price <= max);
}

export function byTags(products: Product[], tags: string[]): Product[] {
  return products.filter((p) => tags.every((t) => p.tags.includes(t)));
}
`,
}, now - 12 * 60_000);

// 3. Recent, with an open PR.
const rounding = worktree('fix/tax-rounding', 'tax-rounding', now - 30 * HOUR);
const roundingHead = commit(rounding, 'Round tax per line item, not on the total', {
  'src/tax.ts': `
const RATES: Record<string, number> = { UK: 0.2, DE: 0.19, FR: 0.2, US: 0 };

export function taxFor(amount: number, region: string): number {
  // Banker's rounding, to match what the payment provider reports.
  const raw = amount * (RATES[region] ?? 0);
  const floor = Math.floor(raw);
  const diff = raw - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}
`,
}, now - 26 * HOUR);
git(REPO, ['update-ref', 'refs/remotes/origin/fix/tax-rounding', roundingHead]);

// 4. Merged and clean: safe to remove.
const deps = worktree('chore/upgrade-node', 'upgrade-node', now - 9 * DAY);
const depsHead = commit(deps, 'Run on Node 22', {
  'package.json': '{\n  "name": "shop",\n  "version": "1.4.0",\n  "type": "module",\n  "engines": { "node": ">=22" },\n  "scripts": { "test": "node --test" }\n}\n',
  '.nvmrc': '22\n',
}, now - 8 * DAY);
git(REPO, ['update-ref', 'refs/remotes/origin/chore/upgrade-node', depsHead]);

// 5. Merged, but someone ran `npm install` in it afterwards.
const apiWt = worktree('refactor/api-client', 'api-client', now - 12 * DAY);
const apiHead = commit(apiWt, 'Retry idempotent API requests', {
  'src/api/client.ts': `
export async function get(path: string, retries = 2): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(\`https://api.example.com\${path}\`);
    if (res.ok || attempt >= retries || res.status < 500) return res.json();
    await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
  }
}
`,
}, now - 11 * DAY);
git(REPO, ['update-ref', 'refs/remotes/origin/refactor/api-client', apiHead]);
write(apiWt, { 'package-lock.json': '{\n  "name": "shop",\n  "lockfileVersion": 3,\n  "requires": true,\n  "packages": { "": { "name": "shop" } }\n}\n' });

// WTR_DEMO_BIG=1: a large worktree for benchmarks (test/bench.ts): 20 commits over 80 files.
if (process.env.WTR_DEMO_BIG) {
  const big = worktree('feat/big-refactor', 'big-refactor', now - 3 * HOUR);
  const fn = (f, i, c) => `export function step${i}_${c}(input: number[]): number {\n  let total = 0;\n  for (const n of input) {\n    if (n % ${i + 2} === 0) total += n * ${c + 1};\n    else total -= Math.floor(n / ${i + 1});\n  }\n  return total; // ${f}\n}\n`;
  for (let c = 0; c < 20; c++) {
    const files = {};
    for (let f = c * 4; f < c * 4 + 4; f++) files[`src/modules/m${f}.ts`] = Array.from({ length: 12 }, (_, i) => fn(f, i, c)).join('\n');
    // Later commits also edit earlier files, so lines come from many commits.
    if (c > 0) files[`src/modules/m${(c - 1) * 4}.ts`] = fs.readFileSync(path.join(big, `src/modules/m${(c - 1) * 4}.ts`), 'utf8').replace(/total \+= n/g, `total += n + ${c}`);
    commit(big, `Refactor step ${c + 1}: modules ${c * 4}-${c * 4 + 3}`, files, now - (3 - c * 0.1) * HOUR);
  }
}

// 6. An old spike nothing has touched in weeks.
const spike = worktree('spike/graphql-gateway', 'graphql-spike', now - 19 * DAY);
commit(spike, 'Sketch a GraphQL gateway over the REST API', {
  'src/gateway.ts': "export const typeDefs = `\n  type Product { sku: ID!, name: String!, price: Int! }\n  type Query { products: [Product!]! }\n`;\n",
}, now - 18 * DAY);

// Old file times, so the dashboard reads the right "last activity".
const age = (dir, ms) => {
  const t = new Date(now - ms);
  for (const f of execFileSync('git', ['ls-files', '-mo', '--exclude-standard'], { cwd: dir, encoding: 'utf8' }).split('\n').filter(Boolean)) fs.utimesSync(path.join(dir, f), t, t);
};
age(disc, 20 * 60_000);
age(apiWt, 10 * DAY);

// ---------- stand-ins for gh, coderabbit and claude ----------

const lineOf = (dir, file, text) => fs.readFileSync(path.join(dir, file), 'utf8').split('\n').findIndex((l) => l.includes(text)) + 1;
const L = {
  pct: lineOf(disc, 'src/discounts.ts', "return d.kind === 'percent'"),
  expired: lineOf(disc, 'src/discounts.ts', 'd.expiresAt < at'),
  err: lineOf(disc, 'src/checkout.ts', 'throw new DiscountError'),
  tax: lineOf(disc, 'src/checkout.ts', 'const tax = taxFor'),
  test: lineOf(disc, 'test/discounts.test.ts', 'a fixed discount never exceeds'),
};

const prs = {
  'fix/tax-rounding': { number: 42, state: 'OPEN', isDraft: false, title: 'Round tax per line item', headRefOid: roundingHead, mergedAt: null, baseRefName: 'main' },
  'chore/upgrade-node': { number: 38, state: 'MERGED', isDraft: false, title: 'Run on Node 22', headRefOid: depsHead, mergedAt: new Date(now - 7 * DAY).toISOString(), baseRefName: 'main' },
  'refactor/api-client': { number: 35, state: 'MERGED', isDraft: false, title: 'Retry idempotent API requests', headRefOid: apiHead, mergedAt: new Date(now - 10 * DAY).toISOString(), baseRefName: 'main' },
};
for (const pr of Object.values(prs)) pr.url = `https://github.com/acme/shop/pull/${pr.number}`;
fs.writeFileSync(path.join(BIN, 'prs.json'), JSON.stringify(prs));

// The stand-ins are CommonJS scripts; keep the repo's "type": "module" from applying when the demo folder is inside it.
fs.writeFileSync(path.join(BIN, 'package.json'), '{ "type": "commonjs" }\n');
const shim = (name, body) => {
  const p = path.join(BIN, name);
  fs.writeFileSync(p, `#!/usr/bin/env node\nconst args = process.argv.slice(2);\nconst out = (o) => console.log(typeof o === 'string' ? o : JSON.stringify(o));\n(async () => {\n${body}\n})();\n`);
  fs.chmodSync(p, 0o755);
};
shim('gh', `
const prs = JSON.parse(require('fs').readFileSync(${JSON.stringify(path.join(BIN, 'prs.json'))}, 'utf8'));
if (args[0] === '--version') out('gh version 2.62.0 (demo)');
else if (args[0] === 'auth') out('github.com\\n  ✓ Logged in to github.com account sam-rivera (keyring)');
else if (args[0] === 'api') {
  const q = args[args.indexOf('-f') + 1];
  const repository = {};
  for (const m of q.matchAll(/(b\\d+): pullRequests\\(headRefName: ("(?:[^"\\\\]|\\\\.)*")/g)) {
    const pr = prs[JSON.parse(m[2])];
    repository[m[1]] = { nodes: pr ? [pr] : [] };
  }
  out({ data: { repository } });
} else process.exit(1);
`);
shim('coderabbit', `
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (args[0] === '--version') out('0.9.1');
else if (args[0] === 'auth' && args[1] === 'status') {
  if (args.includes('--agent')) out({ authenticated: true, user: { username: 'sam-rivera', email: 'sam@example.com' }, currentOrg: { name: 'acme' }, organizations: [{ name: 'acme' }] });
  else out('Plan: Pro\\nSeat: assigned');
} else if (args[0] === 'usage') {
  out({ includedReviews: { state: 'available', limit: 8, remaining: 6, fullCapacityInMs: 1_800_000, rollingWindowMs: 3_600_000, repository: 'acme/shop' } });
} else if (args[0] === 'review') {
  out({ type: 'review_context', baseBranch: 'main' });
  for (const message of ['Analyzing changes', 'Reviewing files']) { out({ type: 'status', message }); await sleep(400); }
  out({ type: 'finding', severity: 'major', fileName: 'src/discounts.ts', startLine: ${L.pct}, endLine: ${L.pct},
    title: 'Percentage discounts above 100% make the total negative',
    comment: 'Nothing stops a percent code over 100, and discountFor would then return more than the amount. Clamp it like the fixed-amount branch does.',
    codegenInstructions: 'In src/discounts.ts, make discountFor return at most amount for percent codes too.',
    suggestions: ['return d.kind === \\'percent\\' ? Math.min(amount, Math.round((amount * d.percent) / 100)) : Math.min(d.amount, amount);'] });
  await sleep(300);
  out({ type: 'finding', severity: 'minor', fileName: 'src/checkout.ts', startLine: ${L.err}, endLine: ${L.err},
    title: 'Normalise the code before looking it up',
    comment: 'findDiscount already trims and upper-cases, but the error message echoes the raw input. Consider showing the normalised code so support can match it to logs.' });
  await sleep(300);
  out({ type: 'complete', reviewedFiles: ['src/checkout.ts', 'src/discounts.ts', 'test/discounts.test.ts'], message: 'Review complete' });
} else process.exit(1);
`);
// Claude Code's headless /code-review. Like the real CLI, it registers as a live session while it runs.
shim('claude', `
const fs = require('fs'), path = require('path');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (args[0] === '--version') { out('2.1.0 (Claude Code)'); return; }
const flag = (f) => args[args.indexOf(f) + 1];
const fail = (msg) => { console.error(msg); process.exit(2); };
if (!args.includes('-p') || !args.includes('--safe-mode') || !args.includes('--json-schema') || flag('--output-format') !== 'stream-json') fail('unexpected arguments: ' + args.join(' '));
if (process.env.CLAUDECODE || process.env.CLAUDE_CODE_SESSION_ID) fail('started with the environment of another session');
if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(flag('--effort'))) fail('unknown effort: ' + flag('--effort'));
const file = path.join(process.env.HOME, '.claude', 'sessions', process.pid + '.json');
fs.writeFileSync(file, JSON.stringify({ sessionId: 'reviewer-' + process.pid, pid: process.pid, cwd: process.cwd(), status: 'busy', entrypoint: 'sdk-cli' }));
process.on('exit', () => { try { fs.unlinkSync(file); } catch {} });
process.on('SIGTERM', () => process.exit(143));
out({ type: 'system', subtype: 'init' });
out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'code-review' } }] } });
await sleep(800);
out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'git diff main...HEAD' } }] } });
await sleep(400);
const findings = path.basename(process.cwd()) === 'checkout-discounts' ? [
  { file: path.join(process.cwd(), 'src/checkout.ts'), startLine: ${L.tax}, severity: 'major', title: 'Tax is taken after a discount that can exceed the subtotal',
    comment: 'With a percent code over 100, sub - discount is negative, so taxFor gets a negative amount and the order total goes below zero.',
    suggestion: 'const tax = taxFor(Math.max(0, sub - discount), region);' },
] : [];
out({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.18, result: '', structured_output: { findings } });
`);

// ---------- Claude Code sessions ----------

const CLAUDE = path.join(HOME, '.claude');
fs.mkdirSync(path.join(CLAUDE, 'sessions'), { recursive: true });
fs.mkdirSync(path.join(CLAUDE, 'projects', 'shop'), { recursive: true });
const pids = [];
const session = (id, name, status, cwd) => {
  // A live process to stand in for the session's Claude Code process.
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1 << 30)'], { detached: true, stdio: 'ignore' });
  child.unref();
  pids.push(child.pid);
  fs.writeFileSync(path.join(CLAUDE, 'sessions', `${id}.json`), JSON.stringify({ sessionId: id, pid: child.pid, name, status, cwd }));
  fs.writeFileSync(path.join(CLAUDE, 'projects', 'shop', `${id}.jsonl`), JSON.stringify({ type: 'user', cwd, sessionId: id }) + '\n');
};
session('11111111-aaaa-4aaa-8aaa-111111111111', 'shop-checkout', 'idle', disc);
session('22222222-bbbb-4bbb-8bbb-222222222222', 'shop-search', 'busy', search);
session('33333333-cccc-4ccc-8ccc-333333333333', 'shop-main', 'idle', REPO);
// shop-main has a subagent fixing tax rounding in its own worktree, and one that has finished in the spike.
const subagent = (sessionId, agentId, meta, cwd) => {
  const dir = path.join(CLAUDE, 'projects', 'shop', sessionId, 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: 'general-purpose', spawnedWithWorktree: true, ...meta }));
  fs.writeFileSync(path.join(dir, `agent-${agentId}.jsonl`), JSON.stringify({ type: 'user', isSidechain: true, agentId, cwd, sessionId }) + '\n');
};
subagent('33333333-cccc-4ccc-8ccc-333333333333', 'a1b2c3d4e5f6a7b8c', { description: 'Round tax per line item', worktreePath: rounding }, rounding);
subagent('33333333-cccc-4ccc-8ccc-333333333333', 'a9f8e7d6c5b4a3f2e', { description: 'Sketch a GraphQL gateway', worktreePath: spike, finished: true }, spike);
fs.writeFileSync(path.join(DEMO, 'pids'), pids.join('\n'));

// ---------- dashboard state ----------

const DATA = path.join(CLAUDE, 'worktree-review');
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({ roots: [], extraRepos: [], autoCleanup: true, recentDays: 3, prPollMinutes: 5, editor: 'vscode' }, null, 2));
fs.writeFileSync(path.join(DATA, 'state.json'), JSON.stringify({
  installedAt: now - 5 * DAY, onboardedAt: now - 5 * DAY, worktrees: {}, comments: [], reviews: [], codeReviews: {}, trash: [],
  cleaned: [{
    path: path.join(WTS, 'onboarding-docs'), branch: 'docs/onboarding', sha: depsHead, repoRoot: REPO, how: 'auto',
    branchDeleted: true, branchKept: null, at: now - 2 * DAY, reason: 'merged',
    pr: { number: 31, url: 'https://github.com/acme/shop/pull/31', title: 'Onboarding guide', state: 'MERGED' },
  }],
}, null, 2));

// ---------- start the server and add review activity ----------

// CLAUDECODE and CLAUDE_CODE_SESSION_ID are set as when a session's hook starts the server; Claude reviews must run without them.
const env = { ...process.env, HOME, PATH: `${BIN}:${process.env.PATH}`, WTR_PORT: String(PORT), WTR_DATA_DIR: DATA, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'demo-parent-session' };
// WTR_DIST: run a build other than ./dist (the tests use this).
const SERVER = path.join(process.env.WTR_DIST ? path.resolve(process.env.WTR_DIST) : path.join(ROOT, 'dist'), 'server.mjs');
const server = spawn(process.execPath, [SERVER], { env, detached: true, stdio: ['ignore', fs.openSync(path.join(DEMO, 'server.log'), 'a'), fs.openSync(path.join(DEMO, 'server.log'), 'a')] });
server.unref();

const base = `http://127.0.0.1:${PORT}`;
const api = (method, p, body) => fetch(base + p, { method, headers: { 'x-wtr': '1', 'content-type': 'application/json' }, body: body && JSON.stringify(body) }).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let st;
for (let i = 0; i < 100; i++) {
  await sleep(200);
  try { st = await api('GET', '/api/state'); if (st.worktrees.some((w) => w.path === disc && w.mergeBase)) break; } catch {}
}
const wt = st.worktrees.find((w) => w.path === disc);
const c1 = await api('POST', '/api/comments', { wtId: wt.id, file: 'src/discounts.ts', side: 'new', line: L.expired, lineText: "  if (!d || (d.expiresAt && d.expiresAt < at)) return null;", body: 'Should an expired code say so, rather than looking the same as a typo? Support will get asked about this.' });
await api('POST', `/api/comments/${c1.id}/reopen`); // as if it had been sent to Claude
await api('POST', `/api/comments/${c1.id}/reply`, { author: 'claude', body: "Good point. I'll return a reason with the null so checkout can say \"this code expired on 1 June\"." });
const c2 = await api('POST', '/api/comments', { wtId: wt.id, file: 'src/checkout.ts', side: 'new', line: L.tax, lineText: '  const tax = taxFor(sub - discount, region);', body: 'Tax after discount is right for the UK, but check with finance for the US states we ship to.' });
await api('POST', `/api/comments/${c2.id}/resolve`, { note: 'Checked the tax table: all of our US regions tax the discounted price, so this is correct everywhere. Added a comment saying so.' });
await api('POST', '/api/comments', { wtId: wt.id, file: 'test/discounts.test.ts', side: 'new', line: L.test, lineText: "test('a fixed discount never exceeds the amount', () => {", body: 'Add the same test for a percentage code over 100%.' });
await api('POST', `/api/worktrees/${wt.id}/code-review`, { reviewer: 'coderabbit' });
await api('POST', `/api/worktrees/${wt.id}/code-review`, { reviewer: 'claude', effort: 'medium' });
await sleep(2500);

console.log(`Demo running at http://localhost:${PORT}  (folder: ${DEMO})`);
console.log(`Stop it: curl -X POST -H 'x-wtr: 1' localhost:${PORT}/api/shutdown; kill ${pids.join(' ')}`);
