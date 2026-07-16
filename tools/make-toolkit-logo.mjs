// Toolkit ASP avatar: 512x512 PNG. A 3x3 grid of glowing modules (a "rack of tools" for agents),
// one highlighted — modular, infrastructural, brand-neutral across finance + utility services.
import { Resvg } from '@resvg/resvg-js';
import fs from 'node:fs';

const S = 512;
const modules = [];
const gap = 26, pad = 96, cell = (S - pad * 2 - gap * 2) / 3;
for (let r = 0; r < 3; r++) {
  for (let c = 0; c < 3; c++) {
    const x = pad + c * (cell + gap), y = pad + r * (cell + gap);
    const hot = (r === 1 && c === 1) || (r === 0 && c === 2);
    const fill = hot ? '#34D399' : '#1c2b44';
    const stroke = hot ? '#5ff0b6' : '#2b3d5c';
    // little "connector" dots on the right edge of each module
    modules.push(`<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="18" fill="${fill}" stroke="${stroke}" stroke-width="3"/>`);
    if (!hot) modules.push(`<circle cx="${x + cell / 2}" cy="${y + cell / 2}" r="10" fill="#3a5075"/>`);
    else modules.push(`<path d="M ${x + cell * 0.32} ${y + cell * 0.5} L ${x + cell * 0.46} ${y + cell * 0.64} L ${x + cell * 0.7} ${y + cell * 0.36}" stroke="#0b1220" stroke-width="9" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`);
  }
}

const svg = `<svg width="${S}" height="${S}" viewBox="0 0 ${S} ${S}" xmlns="http://www.w3.org/2000/svg">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#111b2e"/><stop offset="1" stop-color="#080d18"/></linearGradient></defs>
  <rect width="${S}" height="${S}" rx="96" fill="url(#bg)"/>
  <rect x="4" y="4" width="${S - 8}" height="${S - 8}" rx="92" fill="none" stroke="#1b2740" stroke-width="4"/>
  ${modules.join('\n  ')}
</svg>`;

const png = new Resvg(svg, { fitTo: { mode: 'width', value: 512 } }).render().asPng();
fs.mkdirSync(new URL('../assets/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('../assets/toolkit-logo.png', import.meta.url), png);
console.log('wrote assets/toolkit-logo.png', png.length, 'bytes');
