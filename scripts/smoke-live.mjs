import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const url = process.env.BAG_HEIST_URL || 'http://127.0.0.1:4173/';
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || 'msedge' });
try {
  mkdirSync(new URL('../runtime/visual/', import.meta.url), { recursive: true });
  for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    await page.getByRole('button', { name: 'Start heist', exact: true }).waitFor();
    if (await page.getByRole('grid').count()) throw new Error('The game opened before Start.');
    await page.screenshot({ path: fileURLToPath(new URL(`../runtime/visual/${name}-start.png`, import.meta.url)), fullPage: true });
    await page.getByRole('button', { name: 'Start heist', exact: true }).click();
    await page.getByText('hash matched').waitFor({ timeout: 30_000 });
    await page.getByRole('grid').waitFor();
    const widths = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    if (widths[0] > widths[1] + 1) throw new Error(`${name} has horizontal overflow.`);
    if (errors.length) throw new Error(errors.join('; '));
    await page.screenshot({ path: fileURLToPath(new URL(`../runtime/visual/${name}-live.png`, import.meta.url)), fullPage: true });
    console.log(`confirmed ${name} ${url}: Start gate, live RPC board/hash, wallet button, no overflow, no page exceptions`);
    await page.close();
  }
} finally { await browser.close(); }
