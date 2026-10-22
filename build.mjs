#!/usr/bin/env node
// Compiles src/ to dist/, which is committed: a Claude Code plugin is installed straight from
// the repo with no build step, so dist/ is what teammates run.
//
//   node build.mjs           build once
//   node build.mjs --watch   rebuild on change
//   node build.mjs --check   fail if dist/ doesn't match src/ (for CI)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const args = new Set(argv);
const outArg = argv.includes('--out') ? path.resolve(argv[argv.indexOf('--out') + 1]) : null;
const BANNER = '// Generated from src/ by build.mjs. Edit the TypeScript source, not this file.';

function options(out) {
  const common = { bundle: true, format: 'esm', legalComments: 'none', banner: { js: BANNER }, logLevel: 'warning', charset: 'utf8' };
  return [
    { ...common, platform: 'node', target: 'node18', entryPoints: { server: 'src/server/main.ts' }, outdir: out, outExtension: { '.js': '.mjs' } },
    { ...common, platform: 'node', target: 'node18', entryPoints: { hook: 'src/scripts/hook.ts', 'ensure-server': 'src/scripts/ensure-server.ts' }, outdir: path.join(out, 'scripts'), outExtension: { '.js': '.mjs' } },
    { ...common, platform: 'browser', target: ['chrome110', 'firefox115', 'safari16'], entryPoints: { app: 'src/web/app.ts', 'sse-worker': 'src/web/worker/sse-worker.ts' }, outdir: path.join(out, 'public') },
  ].map((o) => ({ ...o, absWorkingDir: ROOT }));
}

function copyStatic(out) {
  const from = path.join(ROOT, 'src', 'web', 'static');
  fs.mkdirSync(path.join(out, 'public'), { recursive: true });
  for (const f of fs.readdirSync(from)) fs.copyFileSync(path.join(from, f), path.join(out, 'public', f));
}

async function build(out) {
  fs.rmSync(out, { recursive: true, force: true });
  await Promise.all(options(out).map((o) => esbuild.build(o)));
  copyStatic(out);
}

function listFiles(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? listFiles(p, base) : [path.relative(base, p)];
  }).sort();
}

const DIST = outArg || path.join(ROOT, 'dist');
if (args.has('--check')) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wtr-build-'));
  try {
    await build(tmp);
    const want = listFiles(tmp), have = listFiles(DIST);
    const stale = [...new Set([...want, ...have])].filter((f) => !want.includes(f) || !have.includes(f)
      || !fs.readFileSync(path.join(tmp, f)).equals(fs.readFileSync(path.join(DIST, f))));
    if (stale.length) {
      console.error(`dist/ is out of date with src/ (${stale.join(', ')}). Run npm run build and commit dist/.`);
      process.exit(1);
    }
    console.log('dist/ is up to date.');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
} else if (args.has('--watch')) {
  copyStatic(DIST);
  for (const o of options(DIST)) await (await esbuild.context(o)).watch();
  fs.watch(path.join(ROOT, 'src', 'web', 'static'), () => copyStatic(DIST));
  console.log('Watching src/ …');
} else {
  await build(DIST);
  console.log('Built dist/.');
}
