// Generate the Veritape avatar: 512x512 PNG.
// Design: deep-navy square, an emerald "tape waveform" whose bars form a V,
// with one amber "flagged" bar — the product in one glyph (a tape with one lie in it).
import { PNG } from 'pngjs';
import fs from 'node:fs';

const S = 512;
const png = new PNG({ width: S, height: S });

const bg = [11, 18, 32];        // #0B1220
const bgTop = [17, 27, 46];     // subtle vertical gradient
const green = [52, 211, 153];   // emerald #34D399
const greenDim = [16, 130, 96];
const amber = [245, 158, 11];   // the flagged bar #F59E0B

function put(x, y, [r, g, b], a = 1) {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (S * y + x) << 2;
  const ia = 1 - a;
  png.data[i] = Math.round(png.data[i] * ia + r * a);
  png.data[i + 1] = Math.round(png.data[i + 1] * ia + g * a);
  png.data[i + 2] = Math.round(png.data[i + 2] * ia + b * a);
  png.data[i + 3] = 255;
}

// Background gradient
for (let y = 0; y < S; y++) {
  const t = y / S;
  const col = [
    Math.round(bgTop[0] * (1 - t) + bg[0] * t),
    Math.round(bgTop[1] * (1 - t) + bg[1] * t),
    Math.round(bgTop[2] * (1 - t) + bg[2] * t),
  ];
  for (let x = 0; x < S; x++) put(x, y, col);
}

// Rounded-rect corner mask (transparent-look corners darkened to pure bg edge)
const R = 96;
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const cx = x < R ? R : x >= S - R ? S - R - 1 : x;
    const cy = y < R ? R : y >= S - R ? S - R - 1 : y;
    const d = Math.hypot(x - cx, y - cy);
    if (d > R) put(x, y, [5, 8, 15]);
  }
}

// Waveform bars forming a V: heights dip to a vertex at center.
// 13 bars across; bar 9 is the amber "flagged" one.
const bars = 13;
const span = 372;                 // total width of the bar field
const x0 = (S - span) / 2;
const barW = 16;
const gap = (span - bars * barW) / (bars - 1);
const midY = 262;                 // vertical center of the waveform
for (let i = 0; i < bars; i++) {
  const t = Math.abs(i - (bars - 1) / 2) / ((bars - 1) / 2); // 1 at edges, 0 center
  const h = Math.round(58 + t * 150);                        // V: tall edges, short center
  const bx = Math.round(x0 + i * (barW + gap));
  const isFlag = i === 9;
  const col = isFlag ? amber : green;
  const colDim = isFlag ? [166, 106, 12] : greenDim;
  for (let y = midY - h; y <= midY + h; y++) {
    // vertical gradient within the bar
    const tt = (y - (midY - h)) / (2 * h || 1);
    const c = [
      Math.round(col[0] * (1 - tt) + colDim[0] * tt),
      Math.round(col[1] * (1 - tt) + colDim[1] * tt),
      Math.round(col[2] * (1 - tt) + colDim[2] * tt),
    ];
    for (let x = bx; x < bx + barW; x++) {
      // rounded bar ends
      const edge = Math.min(y - (midY - h), (midY + h) - y);
      const a = edge < 6 ? Math.max(0, edge / 6) : 1;
      put(x, y, c, a);
    }
  }
}

// Baseline "tape" ticks under the waveform
const tickY = 448;
for (let i = 0; i < 25; i++) {
  const bx = Math.round(70 + i * 15.5);
  const h = i % 4 === 0 ? 14 : 8;
  for (let y = tickY - h; y <= tickY; y++) for (let x = bx; x < bx + 4; x++) put(x, y, [82, 100, 130], 0.9);
}

fs.mkdirSync(new URL('../assets/', import.meta.url), { recursive: true });
const out = new URL('../assets/veritape-logo.png', import.meta.url);
fs.writeFileSync(out, PNG.sync.write(png));
console.log('wrote', out.pathname, fs.statSync(out).size, 'bytes');
