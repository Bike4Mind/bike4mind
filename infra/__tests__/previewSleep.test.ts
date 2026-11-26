/**
 * @vitest-environment node
 *
 * infra/previewSleep.ts is an SST program and does not load outside `sst`, so its wiring is
 * read from source while the pure config is imported directly.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chatCompletionScaling } from '../chatCompletionCapacity';
import { PREVIEW_ASLEEP, PREVIEW_SLEEP_CRON, PREVIEW_WAKE_CRON, previewSleepTargets } from '../previewSleepConfig';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// Strip comments so a commented-out line cannot satisfy the assertions below.
const readInfra = (file: string) =>
  readFileSync(path.join(REPO_ROOT, 'infra', file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

describe('preview sleep config', () => {
  it('sleeps to zero tasks', () => {
    expect(PREVIEW_ASLEEP).toEqual({ min: 0, max: 0 });
  });

  it('sleeps on the weekend and wakes before the work week', () => {
    expect(PREVIEW_SLEEP_CRON).toBe('cron(0 2 ? * SAT *)');
    expect(PREVIEW_WAKE_CRON).toBe('cron(0 11 ? * MON *)');
  });

  it('wakes each service to its regular non-prod bounds', () => {
    const awake = Object.fromEntries(previewSleepTargets().map(t => [t.label, t.awake]));
    expect(awake).toEqual({
      'chat-completion': chatCompletionScaling(false),
      'subscriber-fanout': { min: 1, max: 1 },
    });
    expect(chatCompletionScaling(false)).toEqual({ min: 1, max: 2 });
  });
});

describe('ChatCompletion scaling', () => {
  it('keeps the production bounds', () => {
    expect(chatCompletionScaling(true)).toEqual({ min: 2, max: 6, cpuUtilization: 70 });
  });

  it('is what the service is deployed with', () => {
    expect(readInfra('chatCompletion.ts')).toContain('scaling: chatCompletionScaling(isProd),');
  });
});

describe('preview sleep wiring', () => {
  const source = readInfra('previewSleep.ts');

  it('creates every scheduled action inside the preview-only, non-dev block', () => {
    const gate = source.indexOf('if (isPreviewStage && !$dev) {');
    expect(gate).toBeGreaterThanOrEqual(0);
    const actions = [...source.matchAll(/new aws\.appautoscaling\.ScheduledAction\(/g)].map(m => m.index ?? -1);
    expect(actions).toHaveLength(2);
    for (const at of actions) expect(at).toBeGreaterThan(gate);
    expect(source.trimEnd().endsWith('}')).toBe(true);
    expect(source.slice(0, gate)).not.toContain('ScheduledAction');
  });

  it('targets the services own scalable targets with the sleep and wake bounds', () => {
    expect(source).toContain('service.nodes.autoScalingTarget');
    expect(source).toContain('minCapacity: PREVIEW_ASLEEP.min, maxCapacity: PREVIEW_ASLEEP.max');
    expect(source).toContain('minCapacity: awake.min, maxCapacity: awake.max');
  });

  it('is exported after both services it schedules', () => {
    const index = readInfra('index.ts');
    const at = index.indexOf("export * from './previewSleep';");
    expect(at).toBeGreaterThan(index.indexOf("export * from './chatCompletion';"));
    expect(at).toBeGreaterThan(index.indexOf("export * from './subscriberFanout';"));
  });
});
