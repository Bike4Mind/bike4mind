/**
 * @vitest-environment node
 *
 * Guard for every EventBridge subscription in infra/: EventBridge silently drops an event once a
 * rule target's delivery retries are exhausted unless the target has a dead-letter queue. Each
 * subscription must dead-letter into a queue that (a) EventBridge is allowed to send to and (b) is
 * alarmed in infra/dlqAlarms.ts.
 *
 * Text-matched, not executed: infra/ is an SST program and does not load outside `sst`.
 * Subscriptions contributed by premium overlays and `subscribeQueue` rules are not covered.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file: string) => readFileSync(path.join(REPO_ROOT, file), 'utf8');
const DLQ_ALARMS_SOURCE = read('infra/dlqAlarms.ts');

// Every top-level infra module is scanned, so a subscription added to a new file cannot slip past
// the guard: the coverage test below fails until that file is listed here.
const INFRA_FILES = readdirSync(path.join(REPO_ROOT, 'infra'), { withFileTypes: true })
  .filter(entry => entry.isFile() && entry.name.endsWith('.ts'))
  .map(entry => `infra/${entry.name}`);

const SUBSCRIBE_FILES = ['infra/eventBus.ts', 'infra/llm.ts'];

const SUBSCRIBE = /(?:const (\w+) = )?eventBus\.subscribe\(([\s\S]*?)\n\}?\);/g;
const rawSubscribeCount = (source: string) => source.match(/eventBus\.subscribe\(/g)?.length ?? 0;

type Subscription = {
  file: string;
  source: string;
  variable: string | undefined;
  chunk: string;
  name: string;
};

const subscriptions: Subscription[] = SUBSCRIBE_FILES.flatMap(file => {
  const source = read(file);
  return [...source.matchAll(SUBSCRIBE)].map(([, variable, chunk]) => ({
    file,
    source,
    variable,
    chunk,
    name: chunk.match(/^\s*'([^']+)'/)?.[1] ?? '<unnamed>',
  }));
});

// The const's own object literal, bounded at its closing `\n};` so the search cannot run on into
// the next declaration.
const declaredObject = (source: string, name: string) =>
  source.match(new RegExp(`const ${name}\\s*=\\s*\\{[\\s\\S]*?\\n\\};`))?.[0];

// Resolves the queue a subscription dead-letters into: the rule args either carry
// `deadLetterConfig: { arn }` inline, or point at a shared `transform: <const>` object such as
// sessionEnrichmentRuleDLQ. Every transform in the chunk is considered, because a session
// subscription also carries a function-side transform whose `targetArn` is not a rule DLQ.
const deadLetterQueue = ({ source, chunk }: Subscription) => {
  const direct = chunk.match(/deadLetterConfig:\s*\{\s*arn:\s*(\w+)\.arn/)?.[1];
  if (direct) return direct;
  for (const [, name] of chunk.matchAll(/transform:\s*(\w+)\s*[,}\n]/g)) {
    const shared = declaredObject(source, name)?.match(/deadLetterConfig:\s*\{\s*arn:\s*(\w+)\.arn/)?.[1];
    if (shared) return shared;
  }
  return undefined;
};

// The rule ARNs the policy is allowed to accept sends from: this subscription's own rule, or the
// rule list ($util.all(<list>.map(...))) that the session rules share.
const ruleArnRefs = (sub: Subscription) => {
  const direct = `${sub.variable}\\.nodes\\.rule\\.arn`;
  const lists = [...sub.source.matchAll(/const (\w+) = \[([^\]]*)\]/g)]
    .filter(([, , members]) => new RegExp(`\\b${sub.variable}\\b`).test(members))
    .map(([, list]) => `\\$util\\.all\\(\\s*${list}\\.map\\(sub => sub\\.nodes\\.rule\\.arn\\)\\s*\\)`);
  return [direct, ...lists].join('|');
};

describe('every event bus subscription dead-letters undeliverable events', () => {
  it('discovers every subscribe() call', () => {
    for (const file of INFRA_FILES) {
      expect(subscriptions.filter(s => s.file === file)).toHaveLength(rawSubscribeCount(read(file)));
    }
  });

  it('covers every infra file that subscribes to a bus', () => {
    const withSubscriptions = INFRA_FILES.filter(file => rawSubscribeCount(read(file)) > 0).sort();
    expect(withSubscriptions).toEqual([...SUBSCRIBE_FILES].sort());
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

      // $util.all pairs the queue EventBridge sends to with the rule(s) it accepts sends from. A
      // policy naming the wrong queue or rule deploys green and silently rejects the DLQ send.
      // The trailing comma is optional: prettier breaks a long array one element per line.
      const ws = '\\s*';
      expect(policy).toMatch(new RegExp(`\\.all\\(\\[${ws}${dlq}\\.arn,${ws}(?:${ruleArnRefs(sub)}),?${ws}\\]\\)`));

      // The aliases destructured from that pair are the ones the statement must use.
      const aliases = policy?.match(/\.apply\(\(\[(\w+),\s*(\w+)\]\)/);
      expect(aliases).toBeTruthy();
      const [, dlqAlias, ruleAlias] = aliases ?? [];
      expect(policy).toMatch(new RegExp(`Resource:${ws}${dlqAlias}\\b`));
      expect(policy).toMatch(new RegExp(`'aws:SourceArn':\\s*${ruleAlias}\\b`));
    });

    it('has the DLQ alarmed', () => {
      expect(DLQ_ALARMS_SOURCE).toMatch(new RegExp(`createDlqAlarms\\(\\{[^}]*queue:\\s*${dlq}\\b`));
    });
  });
});
