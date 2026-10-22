/**
 * @vitest-environment node
 *
 * Guard for the EventBridge subscriptions in infra/eventBus.ts and infra/llm.ts: each must
 * dead-letter on both sides of its async Lambda invoke (why: see infra/eventBusDeadLetter.ts),
 * and every dead letter must be reachable by its rules and alarmed. A new subscription that
 * copies an older block would otherwise drop failed events silently.
 *
 * Text-matched, not executed: infra/ is an SST program and does not load outside `sst`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readInfra = (file: string) => readFileSync(path.join(REPO_ROOT, 'infra', file), 'utf8');
const EVENT_BUS_SOURCE = readInfra('eventBus.ts');
const DLQ_ALARMS_SOURCE = readInfra('dlqAlarms.ts');
const FUNCTIONS_SOURCE = readInfra('functions.ts');
const SUBSCRIBING_FILES = ['eventBus.ts', 'llm.ts'];

// One match per `eventBus.subscribe(` call, cut at its column-0 `);` (or `});` for the
// single-object-arg form) so a subscription cannot pass on text that belongs to the code after
// it. `variable` is the const it is assigned to.
const parseSubscriptions = (file: string) =>
  [...readInfra(file).matchAll(/(?:const (\w+) = )?eventBus\.subscribe\(([\s\S]*?)\n\}?\);/g)].map(
    ([, variable, chunk]) => ({
      file,
      variable,
      name: chunk.match(/^\s*'([^']+)'/)?.[1] ?? '<unnamed>',
      detailTypes: [...chunk.matchAll(/detailType:\s*\[([^\]]*)\]/g)].map(m => m[1]),
      // The second argument is either an inline handler definition or an existing function's ARN.
      targetFunction: chunk.match(/^\s*'[^']+',\s*(\w+)\.arn\b/)?.[1],
      chunk,
    })
  );

const allSubscriptions = SUBSCRIBING_FILES.flatMap(parseSubscriptions);
const sessionSubscriptions = allSubscriptions.filter(s => s.detailTypes.some(d => /'session\./.test(d)));

// Subscriptions wired through createEventBusDeadLetter (infra/eventBusDeadLetter.ts). The session
// and telemetry rules predate the factory and are pinned by name below.
const FACTORY_RULE_TARGET = /transform:\s*(\w+DeadLetter)\.ruleTarget\b/;
const LEGACY_DEAD_LETTERED = [
  'session-auto-name',
  'session-context-summarize',
  'session-summarize',
  'session-tag',
  'telemetry-alert',
];
const factorySubscriptions = allSubscriptions
  .filter(s => !LEGACY_DEAD_LETTERED.includes(s.name))
  .map(s => ({ ...s, deadLetter: s.chunk.match(FACTORY_RULE_TARGET)?.[1] }));

describe('every EventBridge subscription dead-letters its failures', () => {
  it('finds every subscription', () => {
    expect(allSubscriptions.map(s => s.name).sort()).toEqual(
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

  it.each(factorySubscriptions.map(s => [s.name, s]))(
    '%s: undeliverable rule-target events reach a DLQ',
    (_name, s) => {
      expect(s.deadLetter).toBeDefined();
    }
  );

  it.each(factorySubscriptions.map(s => [s.name, s]))(
    '%s: failed handler invocations reach the same DLQ',
    (_name, s) => {
      // An ARN target is defined elsewhere, so its function-side wiring lives with that definition.
      const functionSource = s.targetFunction
        ? FUNCTIONS_SOURCE.match(new RegExp(`const ${s.targetFunction} = [\\s\\S]*?\\n\\}\\);`))?.[0]
        : s.chunk;
      expect(functionSource).toBeDefined();
      expect(functionSource).toMatch(new RegExp(`transform:\\s*${s.deadLetter}\\.functionTarget\\b`));
      expect(functionSource).toMatch(new RegExp(`\\b${s.deadLetter}\\.sendPermission\\b`));
    }
  );

  it.each(factorySubscriptions.map(s => [s.name, s]))('%s: EventBridge may deliver to the DLQ', (_name, s) => {
    expect(s.variable).toBeDefined();
    const allowed = readInfra(s.file).match(new RegExp(`${s.deadLetter}\\.allowRules\\(\\[([^\\]]*)\\]`))?.[1] ?? '';
    expect(allowed.split(',').map(v => v.trim())).toContain(s.variable);
  });

  it.each([...new Set(factorySubscriptions.map(s => s.deadLetter))].map(d => [d]))(
    '%s: the DLQ is alarmed',
    deadLetter => {
      expect(DLQ_ALARMS_SOURCE).toMatch(new RegExp(`createDlqAlarms\\(\\{[^}]*queue:\\s*${deadLetter}\\.queue,`));
    }
  );

  it('telemetry-alert: dead-letters both sides into telemetryAlertRuleDLQ', () => {
    const telemetry = allSubscriptions.find(s => s.name === 'telemetry-alert');
    expect(telemetry?.chunk).toMatch(/deadLetterConfig:\s*\{\s*targetArn:\s*telemetryAlertRuleDLQ\.arn/);
    expect(telemetry?.chunk).toMatch(/'sqs:SendMessage'\],\s*resources:\s*\[telemetryAlertRuleDLQ\.arn\]/);
    expect(telemetry?.chunk).toMatch(/deadLetterConfig:\s*\{\s*arn:\s*telemetryAlertRuleDLQ\.arn/);
    expect(EVENT_BUS_SOURCE).toMatch(
      /new aws\.sqs\.QueuePolicy\('telemetryAlertRuleDLQPolicy'[\s\S]*?telemetryAlertSubscription\.nodes\.rule\.arn/
    );
    expect(DLQ_ALARMS_SOURCE).toMatch(/createDlqAlarms\(\{[^}]*queue:\s*telemetryAlertRuleDLQ,/);
  });
});

describe('session.* EventBridge subscriptions dead-letter their failures', () => {
  it('finds the session enrichment subscriptions', () => {
    expect(sessionSubscriptions.map(s => s.name).sort()).toEqual(
      ['session-auto-name', 'session-context-summarize', 'session-summarize', 'session-tag'].sort()
    );
  });

  it.each(sessionSubscriptions.map(s => [s.name, s.chunk]))(
    '%s: failed handler invocations reach the DLQ',
    (_name, chunk) => {
      expect(chunk).toMatch(/transform:\s*sessionEnrichmentFunctionDLQ\b/);
      expect(chunk).toMatch(/sessionEnrichmentDLQSendPermission\b/);
    }
  );

  it.each(sessionSubscriptions.map(s => [s.name, s.chunk]))(
    '%s: undeliverable rule-target events reach the DLQ',
    (_name, chunk) => {
      expect(chunk).toMatch(/transform:\s*sessionEnrichmentRuleDLQ\b/);
    }
  );

  it('wires both dead-letter hooks to the shared queue', () => {
    expect(EVENT_BUS_SOURCE).toMatch(
      /sessionEnrichmentFunctionDLQ\s*=\s*\{[\s\S]*?deadLetterConfig:\s*\{\s*targetArn:\s*sessionEnrichmentDLQ\.arn/
    );
    expect(EVENT_BUS_SOURCE).toMatch(
      /sessionEnrichmentRuleDLQ\s*=\s*\{[\s\S]*?deadLetterConfig:\s*\{\s*arn:\s*sessionEnrichmentDLQ\.arn/
    );
    expect(EVENT_BUS_SOURCE).toMatch(
      /sessionEnrichmentDLQSendPermission\s*=\s*\{[\s\S]*?'sqs:SendMessage'[\s\S]*?sessionEnrichmentDLQ\.arn/
    );
  });

  it('lets EventBridge deliver to the DLQ from every session rule', () => {
    const policy = EVENT_BUS_SOURCE.match(/new aws\.sqs\.QueuePolicy\('sessionEnrichmentDLQPolicy'[\s\S]*?\n\}\);/);
    expect(policy).not.toBeNull();
    expect(policy?.[0]).toMatch(/events\.amazonaws\.com/);
    const listed = (EVENT_BUS_SOURCE.match(/const sessionEnrichmentSubscriptions\s*=\s*\[([^\]]*)\]/)?.[1] ?? '')
      .split(',')
      .map(v => v.trim())
      .filter(Boolean);
    expect(listed.sort()).toEqual(sessionSubscriptions.map(s => s.variable).sort());
  });

  it('alarms the DLQ', () => {
    expect(DLQ_ALARMS_SOURCE).toMatch(
      /createDlqAlarms\(\{\s*label:\s*'session-enrichment',[^}]*queue:\s*sessionEnrichmentDLQ,/
    );
  });
});
