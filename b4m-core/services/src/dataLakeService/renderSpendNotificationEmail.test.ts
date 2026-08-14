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
});

describe('formatMicroUsd', () => {
  it('formats a sub-cent amount with 4 decimals', () => {
    expect(formatMicroUsd(1_000)).toBe('$0.0010');
  });

  it('formats a larger amount with 2 decimals', () => {
    expect(formatMicroUsd(5_000_000)).toBe('$5.00');
  });
});
