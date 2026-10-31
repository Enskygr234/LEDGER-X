#!/usr/bin/env node
/**
 * Generates the Android launcher icons (legacy + adaptive foreground) and
 * splash images from the LEDGER X mark, then copies them into
 * android/app/src/main/res when the Android project exists.
 *   npm run icons
 */
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const out = path.join(root, 'resources', 'android');
const BG = '#0B0D12', ACCENT = '#6C8CFF', ACCENT2 = '#36D6B0';

const mark = (size, { rounded = true, pad = 0 } = {}) => {
  const s = size, p = pad;
  const inner = s - 2 * p;
  const k = inner / 32;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
  ${rounded ? `<rect width="${s}" height="${s}" rx="${s * 0.22}" fill="${BG}"/>` : ''}
  <g transform="translate(${p},${p}) scale(${k})">
    <rect x="3" y="3" width="26" height="26" rx="7.5" fill="${ACCENT}"/>
    <path d="M11 10v12h5.5" stroke="${BG}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    <path d="M18 14l4.5 5.5M22.5 14L18 19.5" stroke="${ACCENT2}" stroke-width="2.2" stroke-linecap="round"/>
  </g></svg>`);
};

const DENS = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
fs.mkdirSync(out, { recursive: true });
for (const [d, f] of Object.entries(DENS)) {
  const dir = path.join(out, `mipmap-${d}`);
  fs.mkdirSync(dir, { recursive: true });
  await sharp(mark(Math.round(48 * f), { pad: Math.round(4 * f) })).png().toFile(path.join(dir, 'ic_launcher.png'));
  await sharp(mark(Math.round(48 * f), { pad: Math.round(4 * f) })).png().toFile(path.join(dir, 'ic_launcher_round.png'));
  // Adaptive icon foreground: 108dp canvas, artwork inside the 66dp safe zone.
  await sharp(mark(Math.round(108 * f), { rounded: false, pad: Math.round(30 * f) })).png().toFile(path.join(dir, 'ic_launcher_foreground.png'));
}
fs.mkdirSync(path.join(out, 'values'), { recursive: true });
fs.writeFileSync(path.join(out, 'values', 'ic_launcher_background.xml'), `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${BG}</color>\n</resources>\n`);
for (const [name, w, hgt] of [['drawable/splash.png', 480, 800], ['drawable-port-xxhdpi/splash.png', 1080, 1920], ['drawable-land-xxhdpi/splash.png', 1920, 1080]]) {
  const file = path.join(out, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const m = Math.round(Math.min(w, hgt) * 0.22);
  await sharp({ create: { width: w, height: hgt, channels: 4, background: BG } })
    .composite([{ input: await sharp(mark(m, { rounded: false })).png().toBuffer(), gravity: 'center' }]).png().toFile(file);
}
await sharp(mark(512)).png().toFile(path.join(root, 'resources', 'icon-512.png'));
console.log(`✓ Android resources written to ${path.relative(root, out)}`);

const res = path.join(root, 'android', 'app', 'src', 'main', 'res');
if (fs.existsSync(res)) {
  const copy = (from, to) => {
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      const a = path.join(from, e.name), b = path.join(to, e.name);
      if (e.isDirectory()) { fs.mkdirSync(b, { recursive: true }); copy(a, b); } else fs.copyFileSync(a, b);
    }
  };
  copy(out, res);
  console.log('✓ Copied into android/app/src/main/res');
} else {
  console.log('  (Run `npx cap add android` first, then `npm run icons` again to install them.)');
}
