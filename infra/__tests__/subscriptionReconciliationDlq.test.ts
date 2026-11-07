// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const readInfra = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

describe('subscription reconciliation dead letter', () => {
  it('registers a DLQ alarm for the cron-sourced queue', () => {
    const source = readInfra('dlqAlarms.ts');
    const block = source.slice(
      source.indexOf('if (subscriptionReconciliationDeadLetter)'),
      source.indexOf('// FabFile Moderation DLQ')
    );
    expect(block).toContain('queue: subscriptionReconciliationDeadLetter.queue,');
  });

  it('points both sides of the cron invoke at the queue and lets the rule deliver to it', () => {
    const source = readInfra('cron.ts');
    const block = source.slice(source.indexOf("new sst.aws.Cron('subscriptionReconciliation'"));
    expect(block).toContain('transform: subscriptionReconciliationDeadLetter.functionTarget,');
    expect(block).toContain('...subscriptionReconciliationDeadLetter.ruleTarget.target,');
    expect(block).toContain(
      'subscriptionReconciliationDeadLetter.allowRules([$util.output(subscriptionReconciliationCron)]);'
    );
  });
});
