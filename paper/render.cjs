// Render the Quiver whitepaper HTML to a print-quality PDF via headless Chromium.
//
// Two things were wrong with the previous version of this file, both found on 9 August 2026 while
// checking whether the shipped PDF still matched the paper.
//
// 1. It resolved `playwright` from this directory, which has no node_modules, so it threw
//    "Cannot find module 'playwright'" and had presumably been run by hand from somewhere else. A build
//    script that only works from an undocumented working directory is a build script that stops being
//    run, and the shipped PDF drifted 45 minutes behind its own source as a result.
// 2. It read a private copy of the HTML that nobody kept in step with the served one. The copy was
//    stale by three paragraphs, one of which still carried a claim the served paper had already
//    corrected: that every output ships a not-advice disclosure, when in fact it ships on ten of the
//    thirteen observation services and none of the nine risk engines.
//
// Both are fixed here: playwright resolves from the veritape install where this repo keeps it, and the
// input is copied from the served paper immediately before rendering, so the PDF cannot silently
// describe a different document than the one at /paper.
const { createRequire } = require('module');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const SERVED = path.join(ROOT, 'veritape', 'assets', 'whitepaper.html');
const INPUT = path.join(__dirname, 'quiver-whitepaper.html');
const OUT = path.join(__dirname, 'Quiver-Technical-Documentation.pdf');

const req = createRequire(path.join(ROOT, 'veritape', 'node_modules', '/'));
const { chromium } = req('playwright');

(async () => {
  // Always render what is actually served. Copying here rather than trusting a stale snapshot is the
  // whole point; if the two ever diverge again it will be because someone edited the copy, and the copy
  // is overwritten on every run.
  fs.copyFileSync(SERVED, INPUT);
  console.log(`source synced from ${path.relative(ROOT, SERVED)} (${fs.statSync(INPUT).size} bytes)`);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`file:///${INPUT.split(path.sep).join('/')}`, { waitUntil: 'networkidle' });
  const footer =
    '<div style="width:100%; font-size:7.5px; font-family:Georgia, serif; color:#8a94a3; '
    + 'padding:0 18mm; display:flex; justify-content:space-between; align-items:center;">'
    + '<span>Quiver &#183; Technical Documentation &#183; v1.0</span>'
    + '<span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>';
  await page.pdf({
    path: OUT,
    format: 'A4',
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate: footer,
    margin: { top: '17mm', bottom: '15mm', left: '17mm', right: '17mm' },
  });
  await browser.close();
  const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
  console.log(`PDF written: ${path.basename(OUT)} (${kb} KB)`);
})().catch((e) => { console.error('RENDER FAILED:', e.message); process.exit(1); });
