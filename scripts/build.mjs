#!/usr/bin/env node
/**
 * Production build: bundles src/ into dist/ (the Capacitor webDir).
 *   node scripts/build.mjs           one-off build
 *   node scripts/build.mjs --watch   rebuild on change
 *
 * Optional build-time cloud defaults come from .env (never committed):
 *   SUPABASE_URL=https://xxxx.supabase.co
 *   SUPABASE_ANON_KEY=eyJ...   (anon/public key only)
 */
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const src = path.join(root, 'src');
const dist = path.join(root, 'dist');
const watch = process.argv.includes('--watch');
const require = createRequire(path.join(root, 'package.json'));

function readEnv() {
  const env = {};
  const file = path.join(root, '.env');
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
  for (const k of ['SUPABASE_URL', 'SUPABASE_ANON_KEY']) if (process.env[k]) env[k] = process.env[k];
  if (/service_role/i.test(Buffer.from((env.SUPABASE_ANON_KEY || '').split('.')[1] || '', 'base64').toString())) {
    throw new Error('SUPABASE_ANON_KEY is a service-role key. Refusing to bundle it into the app.');
  }
  return { SUPABASE_URL: env.SUPABASE_URL || '', SUPABASE_ANON_KEY: env.SUPABASE_ANON_KEY || '' };
}

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function copyDir(from, to) {
  if (!fs.existsSync(from)) return;
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b); else copy(a, b);
  }
}

function resolvePkgFile(pkg, rel) {
  try { return path.join(path.dirname(require.resolve(`${pkg}/package.json`)), rel); } catch { return null; }
}

function staticFiles() {
  fs.mkdirSync(dist, { recursive: true });
  copy(path.join(src, 'index.html'), path.join(dist, 'index.html'));
  copy(path.join(src, 'boot.js'), path.join(dist, 'boot.js'));
  copyDir(path.join(src, 'assets'), path.join(dist, 'assets'));
  const css = ['fonts', 'tokens', 'themes', 'global', 'components'].map((n) => fs.readFileSync(path.join(src, 'styles', `${n}.css`), 'utf8')).join('\n');
  fs.writeFileSync(path.join(dist, 'app.css.src'), css);
  // PDF.js (preview) and sql.js (browser SQLite) are copied as vendor files.
  const vendor = [
    ['pdfjs-dist', 'build/pdf.min.mjs', 'pdf.min.mjs'],
    ['pdfjs-dist', 'build/pdf.worker.min.mjs', 'pdf.worker.min.mjs'],
    ['sql.js', 'dist/sql-wasm.js', 'sql-wasm.js'],
    ['sql.js', 'dist/sql-wasm.wasm', 'sql-wasm.wasm'],
  ];
  for (const [pkg, rel, out] of vendor) {
    const f = resolvePkgFile(pkg, rel);
    if (f && fs.existsSync(f)) copy(f, path.join(dist, 'vendor', out));
    else if (pkg === 'sql.js') console.warn(`! ${pkg} not installed — browser-only mode needs it (Android uses native SQLite).`);
    else console.warn(`! missing ${pkg}/${rel}`);
  }
}

const env = readEnv();
const options = {
  entryPoints: { app: path.join(src, 'main.js') },
  bundle: true,
  format: 'esm',
  target: ['chrome89', 'safari15'],
  outdir: dist,
  sourcemap: true,
  minify: !watch,
  legalComments: 'linked',
  banner: { js: `globalThis.__LEDGERX_ENV__ = ${JSON.stringify(env)};` },
  logLevel: 'info',
};

async function buildCss() {
  await esbuild.build({ entryPoints: [path.join(dist, 'app.css.src')], loader: { '.src': 'css' }, outfile: path.join(dist, 'app.css'), minify: !watch, logLevel: 'warning' });
  fs.rmSync(path.join(dist, 'app.css.src'));
}

fs.rmSync(dist, { recursive: true, force: true });
staticFiles();
await buildCss();
if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  fs.watch(src, { recursive: true }, async (_e, file) => {
    if (file && !file.endsWith('.js')) { staticFiles(); await buildCss(); console.log(`↻ ${file}`); }
  });
  console.log('Watching src/ …');
} else {
  await esbuild.build(options);
  const size = fs.statSync(path.join(dist, 'app.js')).size;
  console.log(`✓ dist/ built (app.js ${(size / 1024).toFixed(0)} KB)`);
}
