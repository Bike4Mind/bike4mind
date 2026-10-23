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
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readInfra = (file: string) => readFileSync(path.join(REPO_ROOT, 'infra', file), 'utf8');
const DLQ_ALARMS_SOURCE = readInfra('dlqAlarms.ts');
const FUNCTIONS_SOURCE = readInfra('functions.ts');
const DEAD_LETTER_SOURCE = readInfra('eventBusDeadLetter.ts');
// Discovered rather than listed, so a subscription added in any other infra file is covered too.
const SUBSCRIBING_FILES = readdirSync(path.join(REPO_ROOT, 'infra'))
  .filter(file => file.endsWith('.ts'))
  .filter(file => readInfra(file).includes('eventBus.subscribe('));

// One match per `eventBus.subscribe(` call, cut at its column-0 `);` (or `});` for the
// single-object-arg form) so a subscription cannot pass on text that belongs to the code after
// it. `variable` is the const it is assigned to.
const parseSubscriptions = (file: string) =>
  [...readInfra(file).matchAll(/(?:const (\w+) = )?eventBus\.subscribe\(([\s\S]*?)\n\}?\);/g)].map(
    ([, variable, chunk]) => ({
      file,
      variable,
      name: chunk.match(/^\s*'([^']+)'/)?.[1] ?? '<unnamed>',
      // Every subscription is wired through createEventBusDeadLetter (infra/eventBusDeadLetter.ts).
      deadLetter: chunk.match(/transform:\s*(\w+DeadLetter)\.ruleTarget\b/)?.[1],
      // The second argument is either an inline handler definition or an existing function's ARN.
      targetFunction: chunk.match(/^\s*'[^']+',\s*(\w+)\.arn\b/)?.[1],
      chunk,
    })
  );

const allSubscriptions = SUBSCRIBING_FILES.flatMap(parseSubscriptions);

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

  it.each(allSubscriptions.map(s => [s.name, s]))('%s: undeliverable rule-target events reach a DLQ', (_name, s) => {
    expect(s.deadLetter).toBeDefined();
  });

  it.each(allSubscriptions.map(s => [s.name, s]))('%s: failed handler invocations reach the same DLQ', (_name, s) => {
    // An ARN target is defined elsewhere, so its function-side wiring lives with that definition.
    const functionSource = s.targetFunction
      ? FUNCTIONS_SOURCE.match(new RegExp(`const ${s.targetFunction} = [\\s\\S]*?\\n\\}\\);`))?.[0]
      : s.chunk;
    expect(functionSource).toBeDefined();
    expect(functionSource).toMatch(new RegExp(`transform:\\s*${s.deadLetter}\\.functionTarget\\b`));
    expect(functionSource).toMatch(new RegExp(`\\b${s.deadLetter}\\.sendPermission\\b`));
  });

  it.each(allSubscriptions.map(s => [s.name, s]))('%s: EventBridge may deliver to the DLQ', (_name, s) => {
    expect(s.variable).toBeDefined();
    const allowed = readInfra(s.file).match(new RegExp(`${s.deadLetter}\\.allowRules\\(\\[([^\\]]*)\\]`))?.[1] ?? '';
    expect(allowed.split(',').map(v => v.trim())).toContain(s.variable);
  });

  it.each([...new Set(allSubscriptions.map(s => s.deadLetter))].map(d => [d]))(
    '%s: the DLQ policy admits only its own rules',
    deadLetter => {
      const allowed = SUBSCRIBING_FILES.map(
        file => readInfra(file).match(new RegExp(`${deadLetter}\\.allowRules\\(\\[([^\\]]*)\\]`))?.[1]
      ).filter((list): list is string => list !== undefined);
      expect(allowed).toHaveLength(1);
      expect(
        allowed[0]
          .split(',')
          .map(v => v.trim())
          .filter(Boolean)
          .sort()
      ).toEqual(
        allSubscriptions
          .filter(s => s.deadLetter === deadLetter)
          .map(s => s.variable)
          .sort()
      );
    }
  );

  it.each([...new Set(allSubscriptions.map(s => s.deadLetter))].map(d => [d]))('%s: the DLQ is alarmed', deadLetter => {
    expect(DLQ_ALARMS_SOURCE).toMatch(new RegExp(`createDlqAlarms\\(\\{[^}]*queue:\\s*${deadLetter}\\.queue,`));
  });

  it('reads rule ARNs without resolving the subscriber function', () => {
    // Lifting `.nodes` off the subscribe Output resolves `nodes.function`, which throws at deploy
    // for an ARN-targeted subscriber (slack-completion-start).
    expect(DEAD_LETTER_SOURCE).toMatch(/subscription\.apply\(subscriber => subscriber\.nodes\.rule\.arn\)/);
    expect(DEAD_LETTER_SOURCE).not.toMatch(/subscription\.nodes\b/);
  });
});
