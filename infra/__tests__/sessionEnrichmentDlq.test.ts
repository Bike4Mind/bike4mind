/**
 * @vitest-environment node
 *
 * Guard for the session.* EventBridge subscriptions in infra/eventBus.ts: each must dead-letter
 * into sessionEnrichmentDLQ on both sides of the async invoke (why: see the "Session events"
 * comment there). A new session.* subscription that copies an older block would miss both.
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

// One match per `eventBus.subscribe(` call, cut at its column-0 `);` so a subscription cannot
// pass on text that belongs to the code after it. `variable` is the const it is assigned to.
const sessionSubscriptions = [...EVENT_BUS_SOURCE.matchAll(/(?:const (\w+) = )?eventBus\.subscribe\(([\s\S]*?)\n\);/g)]
  .map(([, variable, chunk]) => ({
    variable,
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
