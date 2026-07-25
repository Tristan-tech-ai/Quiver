// Screenshot the whitepaper in PRINT media, so what gets inspected is what the PDF contains.
// Grepping the HTML source is not verification for a rendered document.
const { chromium } = require('playwright');
const path = require('path');
const { pathToFileURL } = require('url');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 1500 } });
  await page.goto(pathToFileURL(path.resolve(__dirname, '../assets/whitepaper.html')).href, { waitUntil: 'networkidle' });
  await page.emulateMedia({ media: 'print' });

  await page.evaluate(() => document.getElementById('sroadmap').scrollIntoView());
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.resolve(__dirname, '../assets/_shot-roadmap.png') });

  await page.evaluate(() => {
    const h = [...document.querySelectorAll('h3')].find((x) => x.textContent.includes('Independent buyer verification'));
    h.scrollIntoView();
  });
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.resolve(__dirname, '../assets/_shot-buyer.png') });

  await browser.close();
  console.log('shots written');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
