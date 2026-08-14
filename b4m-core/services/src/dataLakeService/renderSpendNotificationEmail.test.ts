import { describe, expect, it } from 'vitest';
import { renderSpendNotificationEmail, formatMicroUsd } from './renderSpendNotificationEmail';
import type { DataLakeSpendNotificationKind, DataLakeSpendNotificationScope } from '@bike4mind/common';

const cases: Array<{ kind: DataLakeSpendNotificationKind; scope: DataLakeSpendNotificationScope }> = [
  { kind: 'stopped', scope: 'switch' },
  { kind: 'stopped', scope: 'rate' },
  { kind: 'budget_exhausted', scope: 'lake' },
  { kind: 'budget_exhausted', scope: 'run' },
  { kind: 'budget_exhausted', scope: 'period' },
  { kind: 'throttled', scope: 'rate' },
  { kind: 'approaching_cap', scope: 'lake' },
  { kind: 'approaching_cap', scope: 'period' },
];

describe('renderSpendNotificationEmail', () => {
  it.each(cases)('renders a non-empty subject and html for $kind/$scope', ({ kind, scope }) => {
    const result = renderSpendNotificationEmail({
      kind,
      scope,
      lakeName: 'My Lake',
      detail: { spentMicroUsd: 4_000_000, budgetMicroUsd: 5_000_000, periodHours: 24, batchId: 'batch-1' },
    });

    expect(result.subject.length).toBeGreaterThan(0);
    expect(result.html).toContain('My Lake');
    expect(result.html).toContain('you own or administer this data lake');
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

  it('does not nest a <p> inside a <p> when a reason string is present (stopped/rate)', () => {
    const result = renderSpendNotificationEmail({
      kind: 'stopped',
      scope: 'rate',
      lakeName: 'My Lake',
      detail: { reason: 'the embedding rate limit is 0 (stopped)' },
    });

    expect(result.html).not.toMatch(/<p>[^<]*<p>/);
    expect(result.html).toContain('the embedding rate limit is 0 (stopped)');
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
