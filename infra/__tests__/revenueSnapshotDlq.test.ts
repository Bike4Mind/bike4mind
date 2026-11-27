// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const readInfra = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

describe('revenue snapshot dead letter', () => {
  it('registers a DLQ alarm for the cron-sourced queue', () => {
    const source = readInfra('dlqAlarms.ts');
    const block = source.slice(
      source.indexOf('if (revenueSnapshotDeadLetter)'),
      source.indexOf('// FabFile Moderation DLQ')
    );
    expect(block).toContain('queue: revenueSnapshotDeadLetter.queue,');
  });

  it('points both sides of the cron invoke at the queue and lets the rule deliver to it', () => {
    const source = readInfra('cron.ts');
    const block = source.slice(source.indexOf("new sst.aws.Cron('revenueSnapshot'"));
    expect(block).toContain('transform: revenueSnapshotDeadLetter.functionTarget,');
    expect(block).toContain('...revenueSnapshotDeadLetter.ruleTarget.target,');
    expect(block).toContain('revenueSnapshotDeadLetter.allowRules([$util.output(revenueSnapshotCron)]);');
  });
});
