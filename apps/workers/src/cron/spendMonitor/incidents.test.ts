import { describe, it, expect } from 'vitest';
import { spendAlertOpenKey, type SpendAlertRecord } from '@bike4mind/common';
import { decideIncidents } from './incidents';
import type { SpendBreach } from './rules';

const now = new Date('2026-10-30T12:00:00.000Z');

const breach = (overrides: Partial<SpendBreach> = {}): SpendBreach => ({
  rule: 'account_spike',
  scopeType: 'User',
  scopeId: 'u1',
  severity: 'warning',
  value: 100,
  baseline: 10,
  ratio: 10,
  ...overrides,
});

const active = (overrides: Partial<SpendAlertRecord> = {}): SpendAlertRecord => ({
  id: 'a1',
  rule: 'account_spike',
  scopeType: 'User',
  scopeId: 'u1',
  openKey: spendAlertOpenKey('account_spike', 'User', 'u1'),
  status: 'open',
  severity: 'warning',
  openedAt: new Date('2026-10-30T11:00:00.000Z'),
  peakValue: 100,
  lastValue: 100,
  lastNotifiedValue: 100,
  clearRuns: 0,
  context: {},
  ...overrides,
});

describe('decideIncidents', () => {
  it('opens an incident for a breach with no active incident', () => {
    const [decision] = decideIncidents([], [breach({ value: 120 })], now);

    expect(decision).toMatchObject({
      kind: 'open',
      alert: {
        openKey: 'account_spike:User:u1',
        status: 'open',
        severity: 'warning',
        openedAt: now,
        peakValue: 120,
        lastValue: 120,
        clearRuns: 0,
      },
    });
  });

  it('treats 1.5x the last notified value as a silent update', () => {
    const [decision] = decideIncidents([active()], [breach({ value: 150 })], now);

    expect(decision).toEqual({
      kind: 'update',
      id: 'a1',
      patch: { lastValue: 150, peakValue: 150, clearRuns: 0 },
    });
  });

  it('escalates at 2x the last notified value', () => {
    const [decision] = decideIncidents([active()], [breach({ value: 200 })], now);

    expect(decision).toEqual({
      kind: 'escalate',
      id: 'a1',
      patch: { lastValue: 200, peakValue: 200, severity: 'warning', clearRuns: 0 },
    });
  });

  it('never sets lastNotifiedValue on escalate', () => {
    const [decision] = decideIncidents([active()], [breach({ value: 500 })], now);

    expect(decision?.kind === 'escalate' && decision.patch).not.toHaveProperty('lastNotifiedValue');
  });

  it('escalates on warning to critical even below 2x', () => {
    const [decision] = decideIncidents([active()], [breach({ value: 110, severity: 'critical' })], now);

    expect(decision).toMatchObject({ kind: 'escalate', patch: { severity: 'critical' } });
  });

  it('escalates an acknowledged incident on a severity rise', () => {
    const [decision] = decideIncidents(
      [active({ status: 'acknowledged' })],
      [breach({ value: 110, severity: 'critical' })],
      now
    );

    expect(decision).toMatchObject({ kind: 'escalate', patch: { severity: 'critical' } });
  });

  it('keeps an acknowledged incident silent at 3x', () => {
    const [decision] = decideIncidents([active({ status: 'acknowledged' })], [breach({ value: 300 })], now);

    expect(decision).toMatchObject({ kind: 'update', patch: { lastValue: 300, peakValue: 300 } });
  });

  it('never lowers severity or peak on a silent update', () => {
    const [decision] = decideIncidents(
      [active({ severity: 'critical', peakValue: 400 })],
      [breach({ value: 120, severity: 'warning' })],
      now
    );

    expect(decision).toEqual({
      kind: 'update',
      id: 'a1',
      patch: { lastValue: 120, peakValue: 400, clearRuns: 0 },
    });
  });

  it('does not lower severity when escalating on growth', () => {
    const [decision] = decideIncidents(
      [active({ severity: 'critical' })],
      [breach({ value: 250, severity: 'warning' })],
      now
    );

    expect(decision).toMatchObject({ kind: 'escalate', patch: { severity: 'critical' } });
  });

  it('counts the first clear run silently', () => {
    const [decision] = decideIncidents([active()], [], now);

    expect(decision).toEqual({ kind: 'update', id: 'a1', patch: { clearRuns: 1 } });
  });

  it('resolves after two consecutive clear runs', () => {
    const [decision] = decideIncidents([active({ clearRuns: 1 })], [], now);

    expect(decision).toEqual({
      kind: 'resolve',
      id: 'a1',
      patch: { status: 'resolved', resolvedAt: now, clearRuns: 2 },
    });
  });

  it('resets clearRuns when a breach follows a clear run', () => {
    const [decision] = decideIncidents([active({ clearRuns: 1 })], [breach({ value: 100 })], now);

    expect(decision).toMatchObject({ kind: 'update', patch: { clearRuns: 0 } });
  });

  it('counts an incident whose scope is absent from the breaches toward resolution', () => {
    const other = breach({ scopeId: 'someone-else' });

    const decisions = decideIncidents([active({ clearRuns: 1 })], [other], now);

    expect(decisions.map(d => d.kind).sort()).toEqual(['open', 'resolve']);
  });

  it('escalates when lastNotifiedValue is undefined after a failed post', () => {
    const [decision] = decideIncidents([active({ lastNotifiedValue: undefined })], [breach({ value: 100 })], now);

    expect(decision?.kind).toBe('escalate');
  });
});
