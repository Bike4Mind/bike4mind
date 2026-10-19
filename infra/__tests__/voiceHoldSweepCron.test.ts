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
const CRON = readFileSync(path.join(REPO_ROOT, 'infra/cron.ts'), 'utf8');
const SELF_HOST = readFileSync(path.join(REPO_ROOT, 'apps/workers/src/selfhost/voiceHoldSweep.ts'), 'utf8');

const cut = (source: string, start: string, end: string) => {
  const from = source.indexOf(start);
  expect(from).toBeGreaterThanOrEqual(0);
  return source.slice(from, source.indexOf(end, from));
};

describe('voiceHoldSweep cron', () => {
  const cron = cut(CRON, "const voiceHoldSweepCron = new sst.aws.Cron('voiceHoldSweep'", '\n});');

  it('runs the workers sweep handler every 5 minutes in the VPC, in production and dev', () => {
    expect(cron).toMatch(/schedule:\s*'rate\(5 minutes\)'/);
    expect(cron).toMatch(/handler:\s*'apps\/workers\/src\/cron\/voiceHoldSweep\.handler'/);
    expect(cron).toMatch(/vpc:\s*lambdaVpc/);
    expect(cron).toMatch(/link:\s*\[\.\.\.allSecrets\]/);
    expect(cron).toMatch(/enabled:\s*\['production',\s*'dev'\]\.includes\(\$app\.stage\)/);
  });

  it('times out before the next run starts', () => {
    const timeout = cron.match(/timeout:\s*'(\d+) minutes'/);
    expect(timeout).not.toBeNull();
    expect(Number(timeout?.[1])).toBeLessThan(5);
  });

  // Without the grant every PutMetricData is denied and swallowed, so the stale-hold alarms never
  // see a datapoint and stay OK forever.
  it('may publish the metrics the stale-hold alarms watch', () => {
    expect(cron).toMatch(/actions:\s*\['cloudwatch:PutMetricData'\]/);
  });

  it('keeps the self-host twin on the same interval', () => {
    expect(SELF_HOST).toMatch(/VOICE_HOLD_SWEEP_INTERVAL_MS = 5 \* 60_000/);
  });

  it('is exported with the other crons', () => {
    expect(CRON).toMatch(/^\s+voiceHoldSweepCron,$/m);
  });
});
