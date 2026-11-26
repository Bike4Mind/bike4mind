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
    expect(PREVIEW_WAKE_CRON).toBe('cron(0 23 ? * SUN *)');
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
    expect(source).toContain('const previewSleepEnabled = isPreviewStage && !isServiceHealthMonitoredStage && !$dev;');
    const gate = source.indexOf('if (previewSleepEnabled) {');
    expect(gate).toBeGreaterThanOrEqual(0);
    const actions = [...source.matchAll(/new aws\.appautoscaling\.ScheduledAction\(/g)].map(m => m.index ?? -1);
    expect(actions).toHaveLength(2);
    for (const at of actions) expect(at).toBeGreaterThan(gate);
    expect(source.slice(0, gate)).not.toContain('ScheduledAction');
  });

  it('targets the services own scalable targets with the sleep and wake bounds', () => {
    expect(source).toContain('service.nodes.autoScalingTarget');
    expect(source).toContain('minCapacity: PREVIEW_ASLEEP.min, maxCapacity: PREVIEW_ASLEEP.max');
    expect(source).toContain('minCapacity: awake.min, maxCapacity: awake.max');
  });

  it('gives the web Lambda grants and targets only on preview, scoped to the own targets', () => {
    const web = source.slice(source.indexOf('export const previewSleepForWeb'));
    expect(web).toMatch(/^export const previewSleepForWeb = previewSleepEnabled\n\s*\?/);
    expect(web.trimEnd()).toMatch(/: \{ environment: \{\}, permissions: \[\] \};$/);
    expect(web.slice(0, web.indexOf(': { environment: {}'))).toContain("NEXT_PUBLIC_PREVIEW_SLEEP_ENABLED: 'true',");
    const register = web.slice(web.indexOf("'application-autoscaling:RegisterScalableTarget'"));
    expect(register.slice(0, register.indexOf('\n          },'))).toContain(
      'resources: targets.map(({ target }) => target.arn)'
    );
    const ecs = web.slice(web.indexOf("'ecs:UpdateService'"));
    expect(ecs.slice(0, ecs.indexOf('\n          },'))).toContain('ecsServiceArn(target.resourceId)');
    const wildcard = [...web.matchAll(/\{ actions: \[([^\]]*)\], resources: \['\*'\] \}/g)].map(m => m[1]);
    expect(wildcard).toEqual([
      "'application-autoscaling:DescribeScalableTargets'",
      "'elasticloadbalancing:DescribeTargetHealth'",
    ]);
    expect(web.match(/'\*'/g)).toHaveLength(2);
    const webTs = readInfra('web.ts');
    expect(webTs).toContain('...previewSleepForWeb.permissions,');
    expect(webTs).toContain('...previewSleepForWeb.environment,');
  });

  it('stands down on any stage the no-tasks alarms watch', () => {
    expect(source).toContain("import { isServiceHealthMonitoredStage } from './serviceHealthAlarms';");
    const alarms = readInfra('serviceHealthAlarms.ts');
    expect(alarms).toContain('export const isServiceHealthMonitoredStage = _isMonitoredStage(');
    expect(alarms).toContain('const isMonitoredStage = isServiceHealthMonitoredStage;');
  });

  it('is exported after both services it schedules', () => {
    const index = readInfra('index.ts');
    const at = index.indexOf("export * from './previewSleep';");
    expect(at).toBeGreaterThan(index.indexOf("export * from './chatCompletion';"));
    expect(at).toBeGreaterThan(index.indexOf("export * from './subscriberFanout';"));
  });
});
