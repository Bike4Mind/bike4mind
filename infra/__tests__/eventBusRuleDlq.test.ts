/**
 * @vitest-environment node
 *
 * Guard for every EventBridge subscription in infra/eventBus.ts and infra/llm.ts: EventBridge
 * silently drops an event once a rule target's delivery retries are exhausted unless the target
 * has a dead-letter queue. Each subscription must dead-letter into a queue that (a) EventBridge
 * is allowed to send to and (b) is alarmed in infra/dlqAlarms.ts.
 *
 * Text-matched, not executed: infra/ is an SST program and does not load outside `sst`.
 * Subscriptions contributed by premium overlays and `subscribeQueue` rules are not covered.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file: string) => readFileSync(path.join(REPO_ROOT, file), 'utf8');
const DLQ_ALARMS_SOURCE = read('infra/dlqAlarms.ts');

const SUBSCRIBE = /(?:const (\w+) = )?(?:eventBus|slackEventBus)\.subscribe\(([\s\S]*?)\n\}?\);/g;
const RAW_SUBSCRIBE = /(?:eventBus|slackEventBus)\.subscribe\(/g;

const subscriptions = ['infra/eventBus.ts', 'infra/llm.ts'].flatMap(file => {
  const source = read(file);
  return [...source.matchAll(SUBSCRIBE)].map(([, variable, chunk]) => ({
    file,
    source,
    variable,
    chunk,
    name: chunk.match(/^\s*'([^']+)'/)?.[1] ?? '<unnamed>',
  }));
});

// Resolves the queue a subscription dead-letters into, directly or via a shared
// `transform: <const>` object such as sessionEnrichmentRuleDLQ.
const deadLetterQueue = ({ source, chunk }: (typeof subscriptions)[number]) => {
  const direct = chunk.match(/deadLetterConfig:\s*\{\s*arn:\s*(\w+)\.arn/)?.[1];
  if (direct) return direct;
  const shared = chunk.match(/transform:\s*(\w+)\s*[,}\n]/)?.[1];
  if (!shared) return undefined;
  const decl = source.match(
    new RegExp(`const ${shared}\\s*=\\s*\\{[\\s\\S]*?deadLetterConfig:\\s*\\{\\s*arn:\\s*(\\w+)\\.arn`)
  );
  return decl?.[1];
};

describe('every event bus subscription dead-letters undeliverable events', () => {
  it('discovers every subscribe() call', () => {
    for (const file of ['infra/eventBus.ts', 'infra/llm.ts']) {
      const raw = read(file).match(RAW_SUBSCRIBE)?.length ?? 0;
      expect(subscriptions.filter(s => s.file === file)).toHaveLength(raw);
    }
  });

  it('matches the known set of rules (update when adding a subscription)', () => {
    expect(subscriptions.map(s => s.name).sort()).toEqual(
      [
        'create-memento',
        'email-send',
        'notebook-curation-complete-analytics',
        'notebook-curation-start',
        'session-auto-name',
        'session-context-summarize',
        'session-summarize',
        'session-tag',
        'slack-completion-start',
        'spider-start',
        'stripe-customer-subscription-updated',
        'stripe-invoice-payment-succeeded',
        'telemetry-alert',
      ].sort()
    );
  });

  describe.each(subscriptions.map(s => [s.name, s] as const))('%s', (_name, sub) => {
    const dlq = deadLetterQueue(sub);

    it('is assigned to a const so its rule ARN can be referenced', () => {
      expect(sub.variable).toBeTruthy();
    });

    it('sets a target deadLetterConfig', () => {
      expect(dlq).toBeTruthy();
    });

    it('lets EventBridge send to the DLQ, scoped to this rule', () => {
      const policies = [...sub.source.matchAll(/new aws\.sqs\.QueuePolicy\([\s\S]*?\n\}\);/g)].map(m => m[0]);
      const policy = policies.find(p => new RegExp(`queueUrl:\\s*${dlq}\\.url`).test(p));
      expect(policy).toBeDefined();
      expect(policy).toContain('events.amazonaws.com');
      expect(policy).toContain('sqs:SendMessage');
      const references = (name: string) => new RegExp(`\\b${name}\\b`).test(policy ?? '');
      // Directly, or through a list of subscriptions such as sessionEnrichmentSubscriptions.
      const viaList = [...sub.source.matchAll(/const (\w+) = \[([^\]]*)\]/g)].some(
        ([, list, members]) => references(list) && new RegExp(`\\b${sub.variable}\\b`).test(members)
      );
      expect(references(sub.variable ?? '<none>') || viaList).toBe(true);
      expect(policy).toMatch(/aws:SourceArn/);
    });

    it('has the DLQ alarmed', () => {
      expect(DLQ_ALARMS_SOURCE).toMatch(new RegExp(`createDlqAlarms\\(\\{[^}]*queue:\\s*${dlq}\\b`));
    });
  });
});
