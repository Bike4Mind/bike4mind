import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
const output = path.resolve(import.meta.dirname, '../../../artifacts/admin-visual');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const results = [];
for (const width of [1440, 768, 390]) for (const theme of ['light', 'dark']) {
  const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: theme });
  await page.goto(`http://127.0.0.1:4317/?theme=${theme}`);
  await page.getByTestId('dlq-queue-selector').click();
  await page.getByTestId('dlq-queue-option-fixture-worker').click();
  for (const state of ['table', 'batch', 'single']) {
    if (state === 'batch') await page.getByTestId('dlq-replay-all').click();
    if (state === 'single') await page.getByTestId('dlq-replay-single-transient-timeout-001').click();
    const name = `dlq-${state}-${theme}-${width}.png`;
    await page.screenshot({ path: path.join(output, name), fullPage: true });
    results.push({ name, width, theme, state, evidence: 'real-component fixture, not full app/E2E', overflow: await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth })) });
    if (state !== 'table') await page.keyboard.press('Escape');
  }
  await page.close();
}
for (const fixture of ['ai', 'brief', 'feedback-close', 'feedback-history', 'setting-row']) {
  for (const width of [1440, 768]) for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: theme });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:4317/?theme=${theme}&page=${fixture}`);
    const ready = { ai: 'AI operations', brief: 'Morning brief', 'feedback-close': 'Close feedback', 'feedback-history': 'Internal history', 'setting-row': 'Settings row primitive' }[fixture];
    await page.getByText(ready, { exact: true }).first().waitFor();
    if (fixture === 'ai') await page.getByTestId('ai-operations-monthly-cap').waitFor();
    if (fixture === 'feedback-history') await page.getByTestId('feedback-history-entry-note-1').waitFor();
    if (fixture === 'brief') await page.getByTestId('morning-brief-facts').waitFor();
    const name = `${fixture}-${theme}-${width}.png`;
    await page.screenshot({ path: path.join(output, name), fullPage: true });
    results.push({ name, width, theme, evidence: 'real-component fixture, not full app/E2E', errors, overflow: await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth })) });
    await page.close();
  }
}
await browser.close();
await writeFile(path.join(output, 'matrix.json'), JSON.stringify(results, null, 2));
for (const [group, entries] of Object.entries(Object.groupBy(results, row => row.name.startsWith('dlq') ? row.state : row.name.split('-')[0]))) {
  const tiles = await Promise.all(entries.map(async (row, index) => {
    const image = await sharp(path.join(output, row.name)).resize({ width: 360, height: 900, fit: 'inside' }).png().toBuffer();
    const label = Buffer.from(`<svg width="380" height="28"><rect width="380" height="28" fill="white"/><text x="8" y="20" font-size="14">${row.name}</text></svg>`);
    return [{ input: label, left: (index % 4) * 380, top: Math.floor(index / 4) * 940 }, { input: image, left: (index % 4) * 380, top: Math.floor(index / 4) * 940 + 30 }];
  }));
  await sharp({ create: { width: 1520, height: Math.ceil(entries.length / 4) * 940, channels: 3, background: '#cccccc' } }).composite(tiles.flat()).png().toFile(path.join(output, `contact-${group}.png`));
}
console.log(JSON.stringify(results, null, 2));
