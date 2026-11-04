// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const readInfra = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

describe('account deletion sweep dead letter', () => {
  it('registers a DLQ alarm for the cron-sourced queue', () => {
    const source = readInfra('dlqAlarms.ts');
    const block = source.slice(
      source.indexOf('if (accountDeletionSweepDeadLetter)'),
      source.indexOf('// FabFile Moderation DLQ')
    );
    const verify = (alarm: string) => expect(alarm).toContain('queue: accountDeletionSweepDeadLetter.queue,');
    verify(block);
    expect(() => verify(block.replace('queue: accountDeletionSweepDeadLetter.queue,', ''))).toThrow();
  });

  it('dead-letters the cron run and does not retry it', () => {
    const source = readInfra('cron.ts');
    const block = source.slice(source.indexOf("new sst.aws.Cron('accountDeletionSweep'"));
    const cron = block.slice(0, block.indexOf('if (accountDeletionSweep && accountDeletionSweepDeadLetter)'));
    expect(cron).toContain('transform: accountDeletionSweepDeadLetter.functionTarget,');
    expect(cron).toContain('...accountDeletionSweepDeadLetter.ruleTarget.target,');
    expect(cron).toContain('retries: 0,');
  });
});
