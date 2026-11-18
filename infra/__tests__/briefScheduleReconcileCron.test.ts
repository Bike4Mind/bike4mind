/**
 * @vitest-environment node
 *
 * Pins the brief schedule reconciler's hosted cron, its alarm, its self-host twin's cadence and the DLQ its
 * per-user work rides on. Text-matched, not executed: infra/ is an SST program and does not load outside `sst`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file: string) => readFileSync(path.join(REPO_ROOT, file), 'utf8');

function block(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from, start).toBeGreaterThanOrEqual(0);
  const to = source.indexOf(end, from);
  expect(to, end).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe('briefScheduleReconcile cron', () => {
  const cron = block(read('infra/cron.ts'), "new sst.aws.Cron('briefScheduleReconcile'", ': undefined;');

  it('runs every 5 minutes in the VPC with no async retries and can publish brief.compose', () => {
    expect(cron).toMatch(/schedule: 'rate\(5 minutes\)'/);
    expect(cron).toMatch(/handler: 'apps\/workers\/src\/cron\/briefScheduleReconcile\.handler'/);
    expect(cron).toMatch(/vpc: lambdaVpc/);
    expect(cron).toMatch(/retries: 0/);
    expect(cron).toMatch(/link: \[\.\.\.allSecrets, eventBus\]/);
  });

  it('has a LambdaErrors alarm on the reconciler function', () => {
    const alarm = block(read('infra/alarms.ts'), "'briefScheduleReconcileLambdaErrors'", '});');
    expect(alarm).toMatch(/metricName: 'Errors'/);
    expect(alarm).toMatch(/FunctionName: briefScheduleReconcileCron\.nodes\.function\.name/);
  });

  it('keeps the self-host twin on the same cadence', () => {
    expect(read('apps/workers/src/selfhost/briefScheduleReconcile.ts')).toMatch(
      /BRIEF_SCHEDULE_RECONCILE_INTERVAL_MS = 5 \* 60_000/
    );
    expect(read('apps/workers/src/selfhost/main.ts')).toMatch(/registerBriefScheduleReconcile\(worker\)/);
  });

  it('sends the per-user brief.compose work through a dead-letter queue', () => {
    const subscription = block(
      read('infra/eventBus.ts'),
      'const briefComposeSubscription = eventBus.subscribe(',
      '\n);'
    );
    expect(subscription).toMatch(/sessionEnrichmentDeadLetter\.functionTarget/);
    expect(subscription).toMatch(/sessionEnrichmentDeadLetter\.ruleTarget/);
  });
});
