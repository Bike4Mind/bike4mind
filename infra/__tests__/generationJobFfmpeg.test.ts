/**
 * @vitest-environment node
 *
 * Scene (compose) jobs run the ffmpeg-static binary inside the generation-job worker. The binary is ~80 MB, so it
 * must reach only that Lambda: installed (not bundled) by its subscription, and registered by its handler rather
 * than imported by shared server code the Next server also traces (packages/server-utils).
 *
 * Text-matched, not executed: infra/ is an SST program and does not load outside `sst`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), 'utf8');

const subscriptionSource = () => {
  const source = read('infra/queues.ts');
  const start = source.indexOf('const generationJobQueueSubscription = generationJobQueue.subscribe(');
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('\n);', start);
  return source.slice(start, end);
};

const listSourceFiles = (rel: string): string[] =>
  readdirSync(path.join(REPO_ROOT, rel), { withFileTypes: true, recursive: true })
    .filter(entry => entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name))
    .map(entry => path.relative(REPO_ROOT, path.join(entry.parentPath, entry.name)));

describe('ffmpeg in the generation-job worker', () => {
  it('is installed into the subscription Lambda and kept out of its bundle', () => {
    const subscription = subscriptionSource();
    expect(subscription).toMatch(/install:\s*\[[^\]]*'ffmpeg-static'/);
    expect(subscription).toMatch(/external:\s*\[[^\]]*'ffmpeg-static'/);
  });

  it('is registered by the worker handler', () => {
    const handler = read('apps/workers/src/queueHandlers/generationJob.ts');
    expect(handler).toMatch(/from 'ffmpeg-static'/);
    expect(handler).toMatch(/configureFfmpegBinary\(/);
  });

  it('is never imported by server-utils, which the Next server traces', () => {
    const importers = listSourceFiles('packages/server-utils/src').filter(file =>
      /from 'ffmpeg-static'|require\('ffmpeg-static'\)/.test(read(file))
    );
    expect(importers).toEqual([]);
  });

  it('is excluded from the Next server trace explicitly', () => {
    const config = read('apps/client/next.config.mjs');
    expect(config).toMatch(/outputFileTracingExcludes[\s\S]*?\*\*\/ffmpeg-static\/\*\*/);
  });
});
