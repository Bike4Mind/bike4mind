import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { expect, it } from 'vitest';

const clientRoot = path.resolve(import.meta.dirname, '../..');
const require = createRequire(import.meta.url);

it('scrubs nested and final error text in real JSON and HTML reports without launching a browser', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'e2e-auth-error-reports-'));
  const token = `synthetic.${randomUUID()}.report`;
  try {
    await writeFile(
      path.join(directory, 'report-error.spec.ts'),
      `import { test } from ${JSON.stringify(path.join(clientRoot, 'e2e/waf-test'))};
import { buildAuthSuccessUrl } from ${JSON.stringify(path.join(clientRoot, 'e2e/helpers/auth-seed'))};
const message = () => 'Synthetic navigation timeout: ' + buildAuthSuccessUrl('/projects', {
  accessToken: process.env.REPORT_PROBE_TOKEN!, userId: 'fixture-user',
});
test('nested error', async () => {
  await test.step('outer', async () => {
    await test.step('inner', async () => { throw new Error(message()); });
  });
});
test('plain error', async () => { throw new Error(message()); });
test('thrown value', async () => { throw message(); });
test('unrelated error', async () => { throw new Error('Token-free diagnostic remains useful'); });
`
    );
    // Reuse the real reporter list, with local output and no setup/auth/page fixtures. Keep the
    // synthetic value out of source so report codeframes cannot create a false-positive leak.
    await writeFile(
      path.join(directory, 'playwright.config.ts'),
      `import config from ${JSON.stringify(path.join(clientRoot, 'playwright.config'))};
import path from 'node:path';
export default {
  ...config,
  testDir: __dirname, testMatch: 'report-error.spec.ts', projects: [{ name: 'browserless' }],
  globalSetup: undefined, globalTeardown: undefined, globalTimeout: 20000,
  workers: 1, retries: 0, use: {}, outputDir: path.join(__dirname, 'test-results'),
  reporter: config.reporter?.map(([reporter, options]) => [
    reporter.startsWith('.') ? path.resolve(${JSON.stringify(clientRoot)}, reporter) : reporter,
    { ...options,
      ...(reporter === 'html' ? { outputFolder: path.join(__dirname, 'html'), open: 'never' } : {}),
      ...(reporter === 'json' ? { outputFile: path.join(__dirname, 'results.json') } : {}),
    },
  ]),
};
`
    );

    const result = spawnSync(
      process.execPath,
      [require.resolve('@playwright/test/cli'), 'test', '--config', path.join(directory, 'playwright.config.ts')],
      {
        cwd: clientRoot,
        env: { ...process.env, CI: '1', REPORT_PROBE_TOKEN: token },
        encoding: 'utf8',
        timeout: 25_000,
        maxBuffer: 4 * 1024 * 1024,
      }
    );
    if (result.error) throw result.error;
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toContain('4 failed');
    expect(result.stdout).not.toContain(token);

    const jsonReport = await readFile(path.join(directory, 'results.json'), 'utf8');
    expect(jsonReport).not.toContain(token);
    expect(jsonReport).toContain('[omitted]');
    expect(jsonReport).toContain('Synthetic navigation timeout');
    expect(jsonReport).toContain('Token-free diagnostic remains useful');
    expect(jsonReport).toContain('inner');

    const html = await readFile(path.join(directory, 'html/index.html'), 'utf8');
    const encodedReport = html.match(/data:application\/zip;base64,([A-Za-z0-9+/=]+)/)?.[1];
    expect(encodedReport).toBeDefined();
    const archive = await JSZip.loadAsync(encodedReport!, { base64: true });
    const entries = Object.values(archive.files).filter(entry => !entry.dir);
    const reports = await Promise.all(entries.map(entry => entry.async('string')));
    expect(reports.join('\n')).not.toContain(token);
    expect(reports.join('\n')).toContain('Synthetic navigation timeout');
    expect(reports.join('\n')).toContain('[omitted]');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
