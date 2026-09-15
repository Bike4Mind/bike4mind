import { describe, expect, it } from 'vitest';
import { renderSpendNotificationEmail, formatMicroUsd } from './renderSpendNotificationEmail';
import type {
  DataLakeSpendNotificationDetail,
  DataLakeSpendNotificationKind,
  DataLakeSpendNotificationScope,
} from '@bike4mind/common';

/**
 * Each fixture's `detail` is the EXACT shape the corresponding `fire()` call site in
 * enforceEmbeddingSpendGate.ts actually constructs - not one maximal fixture shared across
 * every kind/scope pair. A shared fixture is how B2 (budget_exhausted/lake referencing
 * `spentMicroUsd`, which its real producer never supplies) survived four review rounds: every
 * test passed `spentMicroUsd` even for the one pair that never receives it in production.
 * `approaching_cap`/`period` is deliberately excluded - the gate never fires it (see its own
 * comment); it stays a renderer-only reserved case, covered separately below.
 */
const productionCases: Array<{
  kind: DataLakeSpendNotificationKind;
  scope: DataLakeSpendNotificationScope;
  detail: DataLakeSpendNotificationDetail;
}> = [
  { kind: 'stopped', scope: 'switch', detail: { reason: 'the embedding spend switch is off' } },
  { kind: 'stopped', scope: 'rate', detail: { reason: 'the embedding rate limit is 0 (stopped)' } },
  {
    kind: 'throttled',
    scope: 'rate',
    detail: { reason: 'the embedding rate limit (120/min) stayed exhausted after waiting 30000ms', retryable: true },
  },
  { kind: 'budget_exhausted', scope: 'run', detail: { batchId: 'batch-1', budgetMicroUsd: 5_000_000 } },
  { kind: 'budget_exhausted', scope: 'lake', detail: { budgetMicroUsd: 5_000_000 } },
  {
    kind: 'budget_exhausted',
    scope: 'period',
    detail: { budgetMicroUsd: 50_000_000, periodHours: 24, windowEndsAt: new Date('2026-01-01T00:00:00Z') },
  },
  { kind: 'approaching_cap', scope: 'lake', detail: { spentMicroUsd: 4_000_000, budgetMicroUsd: 5_000_000 } },
];

describe('renderSpendNotificationEmail', () => {
  it.each(productionCases)(
    'renders a sensible, non-empty subject and html for $kind/$scope using its REAL detail shape',
    ({ kind, scope, detail }) => {
      const result = renderSpendNotificationEmail({ kind, scope, lakeName: 'My Lake', detail });

      expect(result.subject.length).toBeGreaterThan(0);
      expect(result.html).toContain('My Lake');
      expect(result.html).toContain('you own or administer this data lake');
      // A field genuinely absent from this shape (e.g. spentMicroUsd on budget_exhausted/lake)
      // must never leak an unguarded `undefined`/`NaN` into the rendered copy.
      expect(result.html).not.toMatch(/undefined|NaN/);
    }
  );

  it('reads correctly for budget_exhausted/lake without ever referencing spentMicroUsd (B2 - its only producer never supplies one)', () => {
    const result = renderSpendNotificationEmail({
      kind: 'budget_exhausted',
      scope: 'lake',
      lakeName: 'My Lake',
      detail: { budgetMicroUsd: 5_000_000 },
    });

    expect(result.html).toContain('has reached its per-lake embedding budget of $5.00');
    expect(result.html).not.toContain('has spent');
  });

  it('escapes an HTML-injection attempt in the lake name (subject is plain text, not HTML, and is left raw)', () => {
    const result = renderSpendNotificationEmail({
      kind: 'stopped',
      scope: 'switch',
      lakeName: '<img onerror=alert(1)>',
      detail: {},
    });

    expect(result.html).not.toContain('<img onerror');
    expect(result.html).toContain('&lt;img');
  });

  it('strips CR/LF from the lake name before it reaches any Subject header (B2)', () => {
    const result = renderSpendNotificationEmail({
      kind: 'stopped',
      scope: 'switch',
      lakeName: 'evil\r\nBcc: attacker@example.com',
      detail: {},
    });

    expect(result.subject).not.toMatch(/[\r\n]/);
    expect(result.subject).toContain('evil Bcc: attacker@example.com');
  });

  it('never includes chunk/file/query text - only what detail explicitly carries', () => {
    const result = renderSpendNotificationEmail({
      kind: 'budget_exhausted',
      scope: 'lake',
      lakeName: 'My Lake',
      detail: { spentMicroUsd: 1_000_000, budgetMicroUsd: 2_000_000 },
    });

    expect(result.html).not.toMatch(/chunk|query|passage/i);
  });

  it.each([
    { kind: 'budget_exhausted' as const, scope: 'period' as const },
    { kind: 'approaching_cap' as const, scope: 'period' as const },
  ])(
    'never discloses the platform-wide dollar figure or percentage for $kind/$scope (recipients are tenant lake owners, not platform admins)',
    ({ kind, scope }) => {
      const result = renderSpendNotificationEmail({
        kind,
        scope,
        lakeName: 'My Lake',
        detail: { spentMicroUsd: 40_000_000, budgetMicroUsd: 50_000_000, periodHours: 24 },
      });

      expect(result.subject).not.toMatch(/\$|%/);
      expect(result.html).not.toMatch(/\$|%/);
    }
  );

  it('does not nest a <p> inside a <p>, and does not splice the raw log-style reason into the copy (stopped/rate)', () => {
    const result = renderSpendNotificationEmail({
      kind: 'stopped',
      scope: 'rate',
      lakeName: 'My Lake',
      detail: { reason: 'the embedding rate limit is 0 (stopped)' },
    });

    expect(result.html).not.toMatch(/<p>[^<]*<p>/);
    // N1: the raw reason fragment used to land mid-paragraph as a lowercase, unpunctuated
    // restatement of the sentence before it - the fixed copy never quotes it verbatim.
    expect(result.html).not.toContain('the embedding rate limit is 0 (stopped)');
  });

  it('never promises automatic resumption for a STUCK platform-period denial (B2 - budget at 0, or a single message exceeding the whole budget)', () => {
    const result = renderSpendNotificationEmail({
      kind: 'budget_exhausted',
      scope: 'period',
      lakeName: 'My Lake',
      // No windowEndsAt: enforceEmbeddingSpendGate withholds it for exactly this case, since
      // neither sub-case (budget set to 0, or one message's estimate exceeding the whole
      // budget) ever clears within the current window.
      detail: { budgetMicroUsd: 0, periodHours: 24 },
    });

    expect(result.html).not.toMatch(/resumes automatically/i);
    expect(result.html).not.toMatch(/re-index then/i);
  });

  it('throws on an unhandled kind/scope pair instead of silently rendering the last branch copy', () => {
    expect(() =>
      renderSpendNotificationEmail({
        // 'stopped'/'lake' is not one of the eight valid pairings this renderer handles.
        kind: 'stopped',
        scope: 'lake',
        lakeName: 'My Lake',
        detail: {},
      })
    ).toThrow(/unhandled kind\/scope pair/);
  });
});

describe('formatMicroUsd', () => {
  it('formats a sub-cent amount with 4 decimals', () => {
    expect(formatMicroUsd(1_000)).toBe('$0.0010');
  });

  it('formats a larger amount with 2 decimals', () => {
    expect(formatMicroUsd(5_000_000)).toBe('$5.00');
  });
});
