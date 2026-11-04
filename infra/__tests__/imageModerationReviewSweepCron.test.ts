/**
 * @vitest-environment node
 *
 * Text-matched, not executed: infra/ is an SST program and does not load outside `sst`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file: string) => readFileSync(path.join(REPO_ROOT, file), 'utf8');
const CRON = read('infra/imageModerationReviewSweep.ts');
const DLQ = read('infra/imageModerationReviewSweepDeadLetter.ts');
const DLQ_ALARMS = read('infra/dlqAlarms.ts');
const CRON_INDEX = read('infra/cron.ts');

describe('imageModerationReviewSweep cron', () => {
  it('runs the workers sweep handler on the shared interval in the VPC, in production and dev only', () => {
    expect(CRON).toMatch(/schedule:\s*`rate\(\$\{REVIEW_SWEEP_INTERVAL_MINUTES\} minutes\)`/);
    expect(CRON).toMatch(/handler:\s*'apps\/workers\/src\/cron\/imageModerationReviewSweep\.handler'/);
    expect(CRON).toMatch(/vpc:\s*lambdaVpc/);
    expect(CRON).toMatch(/link:\s*\[\.\.\.allSecrets\]/);
    expect(CRON).toMatch(/runsScheduledJobs\s*&&\s*imageModerationReviewSweepDeadLetter/);
  });

  it('times out well before the next run starts', () => {
    const timeout = CRON.match(/timeout:\s*'(\d+) minutes'/);
    expect(timeout).not.toBeNull();
    expect(Number(timeout?.[1])).toBeLessThan(15);
  });

  // Without the grant every PutMetricData is denied and swallowed, so the alarms never see a
  // datapoint and stay OK forever.
  it('may publish the metrics the alarms watch', () => {
    expect(CRON).toMatch(/actions:\s*\['cloudwatch:PutMetricData'\]/);
  });

  it.each([
    'imageModerationReviewSweepDeadLetter.sendPermission,',
    'transform: imageModerationReviewSweepDeadLetter.functionTarget,',
    'transform: imageModerationReviewSweepDeadLetter.ruleTarget,',
    'imageModerationReviewSweepDeadLetter.allowRules([$util.output(imageModerationReviewSweep)]);',
  ])('dead-letters both handler and delivery failures: %s', wiring => {
    expect(CRON).toContain(wiring);
  });

  it('retains dead-lettered runs for 14 days on scheduled stages only and registers a DLQ alarm', () => {
    expect(DLQ).toContain('messageRetentionSeconds: 1209600');
    expect(DLQ).toMatch(/=\s*runsScheduledJobs\s*\?\s*new sst\.aws\.Queue\(/);
    expect(DLQ_ALARMS).toContain('queue: imageModerationReviewSweepDeadLetter.queue,');
  });

  it('is loaded with the other crons', () => {
    expect(CRON_INDEX).toContain("import './imageModerationReviewSweep';");
  });
});
