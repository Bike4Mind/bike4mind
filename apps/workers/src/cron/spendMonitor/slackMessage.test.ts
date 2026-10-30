import { describe, expect, it } from 'vitest';
import type { ISpendAlert } from '@bike4mind/common';
import { buildSpendAlertMessage, type SpendAlertMessageInput } from './slackMessage';

const appUrl = 'https://app.example.com';
const openedAt = new Date('2026-10-30T10:00:00Z');

const baseAlert: ISpendAlert = {
  rule: 'account_spike',
  scopeType: 'User',
  scopeId: 'u1',
  status: 'open',
  severity: 'critical',
  openedAt,
  peakValue: 7000,
  lastValue: 6000,
  clearRuns: 0,
  context: { baseline: 1500, ratio: 3.8 },
};

const userScope = {
  label: 'jane@example.com',
  payerType: 'User' as const,
  payerId: 'u1',
  adminPath: '/admin/users/u1',
};

const build = (overrides: Partial<SpendAlertMessageInput> = {}) =>
  buildSpendAlertMessage({
    kind: 'open',
    alert: baseAlert,
    scope: userScope,
    creditUsd: 0.01,
    stage: 'production',
    appUrl,
    mention: 'channel',
    ...overrides,
  });

const json = (message: ReturnType<typeof build>) => JSON.stringify(message);

describe('buildSpendAlertMessage', () => {
  it('renders a critical account alert with figures, mention and user button', () => {
    const out = json(build());
    expect(out).toContain('Spend critical: Account spend spike');
    expect(out).toContain('jane@example.com');
    expect(out).toContain('6,000 credits (~$60.00)');
    expect(out).toContain('x3.8');
    expect(out).toContain('<!channel>');
    expect(out).toContain(`${appUrl}/admin/users/u1`);
    expect(out).toContain(`${appUrl}/admin?tab=credit-analytics`);
  });

  it('does not mention for a warning', () => {
    const out = json(build({ alert: { ...baseAlert, severity: 'warning' } }));
    expect(out).not.toContain('<!channel>');
    expect(out).toContain('Spend warning');
  });

  it('omits the user button for an org scope without an admin path', () => {
    const out = json(build({ scope: { label: 'Acme', payerType: 'Organization', payerId: 'o1', adminPath: null } }));
    expect(out).not.toContain('/admin/users/');
    expect(out).toContain('Spend Monitor');
  });

  it('renders no history and n/a when baseline and ratio are missing', () => {
    const out = json(build({ alert: { ...baseAlert, context: { baseline: null, ratio: null } } }));
    expect(out).toContain('no history');
    expect(out).toContain('n/a');
  });

  it('renders platform cost spikes in USD without credit conversion', () => {
    const out = json(
      build({
        alert: {
          ...baseAlert,
          rule: 'platform_cost_spike',
          scopeType: 'platform',
          scopeId: 'all',
          lastValue: 42.5,
          context: { baseline: 10, ratio: 4.25 },
        },
      })
    );
    expect(out).toContain('Platform provider-cost spike');
    expect(out).toContain('$42.50');
    expect(out).toContain('$10.00');
    expect(out).not.toContain('credits (~');
  });

  it('shows top accounts for platform rules and source mix for account rules', () => {
    const breakdown = {
      topModels: [{ model: 'gpt-x', credits: 1200 }],
      topAccounts: [{ label: 'big@example.com', credits: 3000 }],
      sources: { api: 5000, chat: 1000 },
    };
    const platform = json(
      build({ alert: { ...baseAlert, rule: 'platform_spike', scopeType: 'platform', scopeId: 'all' }, breakdown })
    );
    expect(platform).toContain('big@example.com: 3,000');
    expect(platform).not.toContain('Source mix');
    const account = json(build({ breakdown }));
    expect(account).toContain('api: 5,000');
    expect(account).toContain('gpt-x: 1,200');
    expect(account).not.toContain('Top accounts');
  });

  it('renders a short resolve message with peak and duration', () => {
    const out = json(build({ kind: 'resolve', alert: { ...baseAlert, resolvedAt: new Date('2026-10-30T12:10:00Z') } }));
    expect(out).toContain('Resolved: Account spend spike - jane@example.com, peak 7,000 credits, lasted 2h 10m');
    expect(out).not.toContain('<!channel>');
  });

  it('formats sub-hour durations in minutes', () => {
    const out = json(build({ kind: 'resolve', alert: { ...baseAlert, resolvedAt: new Date('2026-10-30T10:45:00Z') } }));
    expect(out).toContain('lasted 45m');
  });

  it('emits ASCII only, even for non-ASCII labels', () => {
    const open = json(
      build({ scope: { ...userScope, label: `J${String.fromCharCode(0xfc)}rgen ${String.fromCharCode(0x2014)} team` } })
    );
    const resolved = json(
      build({ kind: 'resolve', scope: { ...userScope, label: `J${String.fromCharCode(0xfc)}rgen` } })
    );
    expect(open).toMatch(/^\p{ASCII}*$/u);
    expect(resolved).toMatch(/^\p{ASCII}*$/u);
  });
});
