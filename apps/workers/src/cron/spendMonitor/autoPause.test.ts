import { describe, expect, it, vi } from 'vitest';
import type { SpendAlertRecord } from '@bike4mind/common';
import { runAutoPause, selectAutoPauseCandidates, type AutoPauseConfig, type AutoPauseDeps } from './autoPause';

const now = new Date('2026-10-30T10:15:00.000Z');

const config = (overrides: Partial<AutoPauseConfig> = {}): AutoPauseConfig => ({
  mode: 'enforce',
  minCreditsByTier: { standard: 10_000, paid: 0, trusted: 0 },
  ...overrides,
});

let nextId = 0;
const alert = (overrides: Partial<SpendAlertRecord> = {}): SpendAlertRecord => ({
  id: `alert-${++nextId}`,
  rule: 'account_ceiling',
  scopeType: 'User',
  scopeId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
  status: 'open',
  severity: 'critical',
  openedAt: new Date('2026-10-30T10:00:00.000Z'),
  peakValue: 12_000,
  lastValue: 12_000,
  clearRuns: 0,
  context: { accountTier: 'standard' },
  ...overrides,
});

describe('selectAutoPauseCandidates', () => {
  it('selects an open account incident whose current window reaches its tier threshold', () => {
    const incident = alert({ lastValue: 10_000 });

    expect(selectAutoPauseCandidates([incident], config())).toEqual([
      {
        alert: incident,
        scope: { scopeType: 'User', scopeId: 'aaaaaaaaaaaaaaaaaaaaaaaa' },
        tier: 'standard',
        thresholdCredits: 10_000,
      },
    ]);
  });

  it('compares the current window, not the peak', () => {
    expect(selectAutoPauseCandidates([alert({ peakValue: 50_000, lastValue: 9_999 })], config())).toEqual([]);
  });

  it('selects nothing when the mode is off', () => {
    expect(selectAutoPauseCandidates([alert()], config({ mode: 'off' }))).toEqual([]);
  });

  it('skips a tier whose threshold is 0', () => {
    const paid = alert({ context: { accountTier: 'paid' }, lastValue: 1_000_000 });
    expect(selectAutoPauseCandidates([paid], config())).toEqual([]);
  });

  it('applies the threshold of the tier recorded on the incident', () => {
    const trusted = alert({ context: { accountTier: 'trusted' }, lastValue: 60_000 });
    const result = selectAutoPauseCandidates(
      [trusted],
      config({ minCreditsByTier: { standard: 10_000, paid: 0, trusted: 50_000 } })
    );
    expect(result).toMatchObject([{ tier: 'trusted', thresholdCredits: 50_000 }]);
  });

  it('treats an incident with no recognised tier as standard', () => {
    expect(selectAutoPauseCandidates([alert({ context: {} })], config())).toMatchObject([{ tier: 'standard' }]);
    expect(selectAutoPauseCandidates([alert({ context: { accountTier: 'vip' } })], config())).toMatchObject([
      { tier: 'standard' },
    ]);
  });

  it('skips acknowledged incidents, which an admin is already handling', () => {
    expect(selectAutoPauseCandidates([alert({ status: 'acknowledged' })], config())).toEqual([]);
  });

  it('skips incidents that already carry a decision', () => {
    const decided = alert({
      autoPause: { mode: 'shadow', decidedAt: now, tier: 'standard', thresholdCredits: 10_000, valueCredits: 12_000 },
    });
    expect(selectAutoPauseCandidates([decided], config())).toEqual([]);
  });

  it.each(['platform', 'Agent', 'model'] as const)('skips %s incidents, which have no freezable payer', scopeType => {
    expect(selectAutoPauseCandidates([alert({ scopeType, scopeId: 'all' })], config())).toEqual([]);
  });

  it.each(['Organization', 'apiKey'] as const)('selects %s incidents', scopeType => {
    expect(selectAutoPauseCandidates([alert({ scopeType })], config())).toMatchObject([{ scope: { scopeType } }]);
  });
});

const makeDeps = (alerts: SpendAlertRecord[]) => {
  const deps = {
    alerts: {
      findActive: vi.fn(async () => alerts),
      recordAutoPause: vi.fn(async () => true),
    },
    freeze: vi.fn(async () => ({ freezeId: 'freeze-1', created: true })),
    post: vi.fn(async () => undefined),
    adminUrl: 'https://app.example.com/admin?tab=spend-monitor',
    logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } satisfies AutoPauseDeps;
  return deps;
};

describe('runAutoPause', () => {
  it('records a shadow decision and freezes nothing in shadow mode', async () => {
    const incident = alert();
    const deps = makeDeps([incident]);

    const result = await runAutoPause(now, deps, config({ mode: 'shadow' }));

    expect(result).toEqual({ shadow: 1, paused: 0 });
    expect(deps.freeze).not.toHaveBeenCalled();
    expect(deps.alerts.recordAutoPause).toHaveBeenCalledWith(incident.id, {
      mode: 'shadow',
      decidedAt: now,
      tier: 'standard',
      thresholdCredits: 10_000,
      valueCredits: 12_000,
    });
    expect(deps.post).not.toHaveBeenCalled();
  });

  it('freezes the scope, records the freeze and posts once in enforce mode', async () => {
    const incident = alert({ scopeType: 'Organization' });
    const deps = makeDeps([incident]);

    const result = await runAutoPause(now, deps, config());

    expect(result).toEqual({ shadow: 0, paused: 1 });
    expect(deps.freeze).toHaveBeenCalledWith({
      scope: { scopeType: 'Organization', scopeId: incident.scopeId },
      rule: 'account_ceiling',
      spendAlertId: incident.id,
      reason: expect.stringContaining('10,000'),
    });
    expect(deps.alerts.recordAutoPause).toHaveBeenCalledWith(
      incident.id,
      expect.objectContaining({ mode: 'enforce', freezeId: 'freeze-1' })
    );
    expect(deps.post).toHaveBeenCalledTimes(1);
    const [message] = deps.post.mock.calls[0] as unknown as [{ text: string }];
    expect(message.text).toContain('Spending paused automatically');
    expect(JSON.stringify(message)).toContain('https://app.example.com/admin?tab=spend-monitor');
  });

  it('records the decision without a freeze id and stays quiet when the scope was already frozen', async () => {
    const deps = makeDeps([alert()]);
    deps.freeze.mockResolvedValueOnce({ freezeId: 'existing', created: false });

    const result = await runAutoPause(now, deps, config());

    expect(result).toEqual({ shadow: 0, paused: 0 });
    const [, decision] = deps.alerts.recordAutoPause.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(decision).not.toHaveProperty('freezeId');
    expect(deps.post).not.toHaveBeenCalled();
  });

  it('keeps going after one incident fails and reports every failure', async () => {
    const first = alert();
    const second = alert({ scopeId: 'bbbbbbbbbbbbbbbbbbbbbbbb' });
    const deps = makeDeps([first, second]);
    deps.freeze.mockRejectedValueOnce(new Error('db down'));

    await expect(runAutoPause(now, deps, config())).rejects.toThrow(AggregateError);
    expect(deps.freeze).toHaveBeenCalledTimes(2);
    expect(deps.alerts.recordAutoPause).toHaveBeenCalledTimes(1);
    expect(deps.alerts.recordAutoPause).toHaveBeenCalledWith(second.id, expect.anything());
  });

  it('does not read incidents when the mode is off', async () => {
    const deps = makeDeps([alert()]);

    await expect(runAutoPause(now, deps, config({ mode: 'off' }))).resolves.toEqual({ shadow: 0, paused: 0 });
    expect(deps.alerts.findActive).not.toHaveBeenCalled();
  });
});
