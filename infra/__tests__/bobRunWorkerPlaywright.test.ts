/**
 * @vitest-environment node
 *
 * Text-matched, not executed: infra/ is an SST program and does not load outside `sst`.
 *
 * The Bob run worker connects to a remote Chromium with playwright-core, and a connect needs the
 * same Playwright version on both ends. SST installs the unversioned package from the handler's
 * package.json, so these pin that resolution to one exact version.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file: string) => readFileSync(path.join(REPO_ROOT, file), 'utf8');
const QUEUES = read('infra/queues.ts');

const cut = (source: string, start: string, end: string) => {
  const from = source.indexOf(start);
  expect(from, `start marker ${start}`).toBeGreaterThanOrEqual(0);
  const to = source.indexOf(end, from);
  expect(to, `end marker after ${start}`).toBeGreaterThan(from);
  return source.slice(from, to);
};

const SUBSCRIPTION = cut(QUEUES, 'const bobRunQueueSubscription = bobRunQueue.subscribe(', '\n);');
const playwrightCorePin = (packageJson: string): unknown =>
  (JSON.parse(read(packageJson)) as { dependencies?: Record<string, string> }).dependencies?.['playwright-core'];

describe('Bob run worker playwright-core', () => {
  it('ships playwright-core unbundled from an apps/client handler', () => {
    expect(SUBSCRIPTION).toMatch(/handler:\s*'apps\/client\/server\/premium-generated\/bobRunWorker\.dispatch'/);
    expect(SUBSCRIPTION).toMatch(/install:\s*\['playwright-core'\]/);
    expect(SUBSCRIPTION).toMatch(/external:\s*\['playwright-core'\]/);
  });

  it('pins playwright-core to one exact version in apps/client and apps/workers', () => {
    const clientPin = playwrightCorePin('apps/client/package.json');
    expect(clientPin).toMatch(/^\d+\.\d+\.\d+$/);
    expect(playwrightCorePin('apps/workers/package.json')).toBe(clientPin);
  });
});
