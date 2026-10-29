/**
 * @vitest-environment node
 *
 * The stage predicate is loaded for real from constants.ts; cron.ts and loopSchedulerDeadLetter.ts are
 * SST programs, so their gate is text-matched (pattern from chatCompletionCapacity.test.ts).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

vi.mock('@bike4mind/infra', () => import('../../b4m-core/infra/src/stageGating'));

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readInfra = (file: string) =>
  readFileSync(path.join(REPO_ROOT, 'infra', file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

async function load(stage: string, isPreview?: string) {
  vi.resetModules();
  vi.stubGlobal('$app', { name: 'test-app', stage });
  vi.stubEnv('IS_PREVIEW', isPreview);
  return import('../constants');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('runsLoopScheduler', () => {
  it.each(['production', 'dev', 'pr123'])('runs on %s', async stage => {
    expect((await load(stage)).runsLoopScheduler).toBe(true);
  });

  it('skips personal stages', async () => {
    const constants = await load('alice');
    expect(constants.runsLoopScheduler).toBe(false);
    expect(constants.runsScheduledJobs).toBe(false);
  });

  it('runs on a personal stage deployed as a preview', async () => {
    expect((await load('alice', 'true')).runsLoopScheduler).toBe(true);
  });

  it('keeps every other cron off previews', async () => {
    expect((await load('pr123')).runsScheduledJobs).toBe(false);
  });

  it('gates the loop scheduler cron and its DLQ on it', () => {
    expect(readInfra('loopSchedulerDeadLetter.ts')).toMatch(/const loopSchedulerDlq = runsLoopScheduler\b/);
    expect(readInfra('cron.ts')).toMatch(/const loopSchedulerCron =\s*runsLoopScheduler && loopSchedulerDeadLetter/);
  });
});
