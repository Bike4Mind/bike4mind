/**
 * @vitest-environment node
 *
 * Guard for the session.* EventBridge subscriptions in infra/eventBus.ts: each must dead-letter
 * into sessionEnrichmentDLQ on BOTH sides of the async invoke. The rule-target DLQ only sees
 * events EventBridge could not hand to Lambda; a handler that throws, times out or crashes at
 * init is Lambda's async retry, and without a function-level dead-letter target it is dropped
 * with no trace. A new session.* subscription that copies an older block would silently miss both.
 *
 * Text-matched, not executed: infra/ is an SST program and does not load outside `sst`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EVENT_BUS_SOURCE = readFileSync(path.join(REPO_ROOT, 'infra/eventBus.ts'), 'utf8');
const DLQ_ALARMS_SOURCE = readFileSync(path.join(REPO_ROOT, 'infra/dlqAlarms.ts'), 'utf8');

// Each chunk runs from one `eventBus.subscribe(` to the next, so it holds that subscription's
// function args and rule options (and possibly trailing code, which is harmless here).
const sessionSubscriptions = EVENT_BUS_SOURCE.split(/eventBus\.subscribe\(/)
  .slice(1)
  .map(chunk => ({
    name: chunk.match(/^\s*'([^']+)'/)?.[1] ?? '<unnamed>',
    detailTypes: [...chunk.matchAll(/detailType:\s*\[([^\]]*)\]/g)].map(m => m[1]),
    chunk,
  }))
  .filter(s => s.detailTypes.some(d => /'session\./.test(d)));

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
    const listed = EVENT_BUS_SOURCE.match(/const sessionEnrichmentSubscriptions\s*=\s*\[([^\]]*)\]/)?.[1] ?? '';
    for (const variable of [
      'sessionAutoNamingSubscription',
      'sessionSummarizationSubscription',
      'sessionContextSummarizationSubscription',
      'sessionTaggingSubscription',
    ]) {
      expect(listed).toContain(variable);
    }
  });

  it('alarms the DLQ', () => {
    expect(DLQ_ALARMS_SOURCE).toMatch(/createDlqAlarms\(\{[\s\S]*?queue:\s*sessionEnrichmentDLQ,/);
  });
});
