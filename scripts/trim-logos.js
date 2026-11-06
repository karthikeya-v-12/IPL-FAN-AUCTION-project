'use strict';
// Trim transparent/white padding from team logos and save as square PNGs with small padding
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const logoDir = path.join(__dirname, '..', 'public', 'team-logos');
const SIZE = 120; // output square size in pixels
const PADDING = 8; // px of white space around the logo mark

const files = [
  { src: 'RR.webp',   out: 'RR.webp' },
  { src: 'RCB.webp',  out: 'RCB.webp' },
  { src: 'KKR.webp',  out: 'KKR.webp' },
  { src: 'PBKS.webp', out: 'PBKS.webp' },
  // Also reprocess these for consistency
  { src: 'CSK.png',   out: 'CSK.png' },
  { src: 'GT.webp',   out: 'GT.webp' },
  { src: 'LSG.png',   out: 'LSG.png' },
  { src: 'MI.webp',   out: 'MI.webp' },
  { src: 'DC.webp',   out: 'DC.webp' },
  { src: 'SRH.webp',  out: 'SRH.webp' },
];

async function processLogo({ src, out }) {
  const srcPath = path.join(logoDir, src);
  const outPath = path.join(logoDir, out);
  if (!fs.existsSync(srcPath)) { console.log(`SKIP: ${src} not found`); return; }

  const inner = SIZE - PADDING * 2;

  await sharp(srcPath)
    .trim({ background: '#ffffff', threshold: 30 })  // trim white/transparent edges
    .resize(inner, inner, { fit: 'contain', background: '#ffffff' })
    .extend({ top: PADDING, bottom: PADDING, left: PADDING, right: PADDING, background: '#ffffff' })
    .toFile(outPath + '.tmp.png');

  // Replace original with processed version
  fs.renameSync(outPath + '.tmp.png', outPath.replace(/\.(webp|png|jpg)$/, '.png'));
  if (!outPath.endsWith('.png')) fs.unlinkSync(outPath).catch?.(() => {});

  console.log(`OK: ${src} -> ${path.basename(outPath.replace(/\.(webp|png|jpg)$/, '.png'))}`);
}

(async () => {
  for (const f of files) {
    try { await processLogo(f); }
    catch (e) { console.error(`ERR ${f.src}: ${e.message}`); }
  }
})();
