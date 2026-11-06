import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ classify: vi.fn(), verdicts: vi.fn() }));
vi.mock('./activationFunnel', async importOriginal => ({
  ...(await importOriginal<typeof import('./activationFunnel')>()),
  classifyFunnelCohort: mocks.classify,
}));
vi.mock('./realSignup', () => ({ signupVerdictUserIds: mocks.verdicts }));

import { getActivationFunnel, summarizeFunnel } from './activationFunnelSummary';

const NOW = new Date('2026-11-04T12:00:00.000Z');
const member = (id: string, step: string, signupAt = '2026-09-01T10:00:00.000Z') => ({
  id,
  step,
  signupAt: new Date(signupAt),
});
const query = { range: '28d', compare: 'off', signups: 'all' } as const;

beforeEach(() => {
  mocks.classify.mockReset();
  mocks.verdicts.mockReset();
});

describe('summarizeFunnel', () => {
  const members = [
    { step: 'signedUp' },
    { step: 'signedUp' },
    { step: 'firstAction' },
    { step: 'cameBack' },
    { step: 'paid' },
  ] as const;

  it('is cumulative and never grows down the funnel', () => {
    const steps = summarizeFunnel(members);
    expect(steps.map(step => step.reached)).toEqual([5, 3, 2, 1]);
    expect(steps.map(step => step.reached)).toEqual([...steps.map(step => step.reached)].sort((a, b) => b - a));
  });

  it('counts each member once under stoppedHere, so the column sums to the cohort', () => {
    const steps = summarizeFunnel(members);
    expect(steps.map(step => step.stoppedHere)).toEqual([2, 1, 1, 1]);
    expect(steps.reduce((total, step) => total + step.stoppedHere, 0)).toBe(members.length);
  });
});

describe('getActivationFunnel', () => {
  it('does not touch the database for a range over the drill-down limit', async () => {
    expect(await getActivationFunnel({ ...query, range: '12m' }, NOW)).toEqual({ status: 'rangeTooLong', maxDays: 93 });
    expect(mocks.classify).not.toHaveBeenCalled();
    expect(mocks.verdicts).not.toHaveBeenCalled();
  });

  it('computes the activation rate and leaves it null for an empty cohort', async () => {
    mocks.classify.mockResolvedValueOnce({
      members: [member('a', 'signedUp'), member('b', 'cameBack')],
      tooNewIds: ['x', 'y', 'z'],
    });
    const funnel = await getActivationFunnel(query, NOW);
    expect(funnel).toMatchObject({ status: 'ok', tooNew: 3, activationRate: { value: 50, previous: null } });
    mocks.classify.mockResolvedValueOnce({ members: [], tooNewIds: [] });
    expect(await getActivationFunnel(query, NOW)).toMatchObject({ activationRate: { value: null } });
  });

  it('keeps only legit signups in legit mode and asks for the same window', async () => {
    mocks.classify.mockResolvedValueOnce({ members: [member('a', 'paid'), member('b', 'signedUp')], tooNewIds: [] });
    mocks.verdicts.mockResolvedValueOnce(['a']);
    const funnel = await getActivationFunnel({ ...query, signups: 'legit' }, NOW);
    expect(funnel).toMatchObject({ steps: [{ reached: 1 }, { reached: 1 }, { reached: 1 }, { reached: 1 }] });
    const [window] = mocks.classify.mock.calls[0];
    expect(mocks.verdicts).toHaveBeenCalledWith({ ...window, verdict: 'legit' }, expect.anything());
    expect(window.start.toISOString()).toBe('2026-10-08T00:00:00.000Z');
    expect(window.end.toISOString()).toBe('2026-11-05T00:00:00.000Z');
  });

  it('counts only legit signups as too new in legit mode', async () => {
    mocks.classify.mockResolvedValueOnce({ members: [member('a', 'signedUp')], tooNewIds: ['a', 's1', 's2'] });
    mocks.verdicts.mockResolvedValueOnce(['a']);
    const funnel = await getActivationFunnel({ ...query, signups: 'legit' }, NOW);
    expect(funnel).toMatchObject({ signups: 'legit', tooNew: 1 });
  });

  it('keeps the current funnel when the previous period fails', async () => {
    mocks.classify
      .mockResolvedValueOnce({ members: [member('a', 'cameBack')], tooNewIds: [] })
      .mockRejectedValueOnce(new Error('more than 20,000 signups'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const funnel = await getActivationFunnel({ ...query, compare: 'prev' }, NOW);
    expect(funnel).toMatchObject({ status: 'ok', activationRate: { value: 100, previous: null } });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('previous-period'), expect.any(Error));
    warn.mockRestore();
  });

  it('fails with a handled 504 once the request budget is spent', async () => {
    vi.useFakeTimers();
    try {
      mocks.classify.mockReturnValue(new Promise(() => {}));
      const result = getActivationFunnel(query, NOW);
      const assertion = expect(result).rejects.toMatchObject({ statusCode: 504 });
      await vi.advanceTimersByTimeAsync(40_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('computes the previous period for the comparison', async () => {
    mocks.classify
      .mockResolvedValueOnce({ members: [member('a', 'cameBack')], tooNewIds: [] })
      .mockResolvedValueOnce({ members: [member('b', 'signedUp'), member('c', 'signedUp')], tooNewIds: [] });
    const funnel = await getActivationFunnel({ ...query, compare: 'prev' }, NOW);
    expect(funnel).toMatchObject({ activationRate: { value: 100, previous: 0 } });
  });

  it('starts the previous period only once the current one has loaded', async () => {
    let resolveCurrent: (value: unknown) => void = () => {};
    mocks.classify
      .mockReturnValueOnce(new Promise(resolve => (resolveCurrent = resolve)))
      .mockResolvedValueOnce({ members: [], tooNewIds: [] });
    const result = getActivationFunnel({ ...query, compare: 'prev' }, NOW);
    await Promise.resolve();
    expect(mocks.classify).toHaveBeenCalledTimes(1);
    resolveCurrent({ members: [member('a', 'cameBack')], tooNewIds: [] });
    expect(await result).toMatchObject({ activationRate: { value: 100, previous: null } });
    expect(mocks.classify).toHaveBeenCalledTimes(2);
  });

  it('keeps the current funnel when the previous period runs out of budget', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      mocks.classify
        .mockResolvedValueOnce({ members: [member('a', 'cameBack')], tooNewIds: [] })
        .mockReturnValueOnce(new Promise(() => {}));
      const result = getActivationFunnel({ ...query, compare: 'prev' }, NOW);
      await vi.advanceTimersByTimeAsync(40_000);
      expect(await result).toMatchObject({ status: 'ok', activationRate: { value: 100, previous: null } });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('previous-period'), expect.anything());
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('marks paid pending until the end of the UTC day 30 days after signup', async () => {
    // NOW is 2026-11-04T12:00Z; a signup on 2026-10-05 can still convert through the end of 2026-11-04.
    mocks.classify.mockResolvedValueOnce({ members: [member('a', 'paid', '2026-10-05T01:00:00.000Z')], tooNewIds: [] });
    expect(await getActivationFunnel(query, NOW)).toMatchObject({ paidPending: true });
    mocks.classify.mockResolvedValueOnce({ members: [member('a', 'paid', '2026-10-04T23:00:00.000Z')], tooNewIds: [] });
    expect(await getActivationFunnel(query, NOW)).toMatchObject({ paidPending: false });
  });
});
