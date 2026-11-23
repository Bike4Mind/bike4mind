import { describe, expect, it } from 'vitest';
import { budgetHeadroom, chooseRunModel, pacedLanes, TIGHT_HEADROOM } from './pacing';

const at = (hour: number) => new Date(Date.UTC(2026, 0, 1, hour));

describe('budgetHeadroom', () => {
  it('is 1 with no budget, and when spend keeps pace with the day', () => {
    expect(budgetHeadroom(undefined, 50, at(12))).toBe(1);
    expect(budgetHeadroom(100, 50, at(12))).toBe(1);
  });

  it('drops as spend runs ahead of the clock, clamped to 0', () => {
    expect(budgetHeadroom(100, 75, at(12))).toBeCloseTo(0.5);
    expect(budgetHeadroom(100, 120, at(12))).toBe(0);
  });
});

describe('pacedLanes', () => {
  it('scales lanes by headroom, rounding up', () => {
    expect(pacedLanes(4, 1, 0)).toBe(4);
    expect(pacedLanes(4, 0.3, 0)).toBe(2);
    expect(pacedLanes(1, 0.1, 0)).toBe(1);
  });

  it('never drops below the lanes already running', () => {
    expect(pacedLanes(4, 0.1, 3)).toBe(3);
    expect(pacedLanes(4, 0, 2)).toBe(2);
    expect(pacedLanes(4, 0, 0)).toBe(0);
  });
});

describe('chooseRunModel', () => {
  const loop = { model: 'stage', escalationModel: 'big', fallbackModel: 'cheap' };
  const tight = TIGHT_HEADROOM - 0.1;

  it('uses the stage model with headroom, the fallback when tight', () => {
    expect(chooseRunModel(loop, {}, { runsAfterClaim: 1 }, 6, 1)).toMatchObject({ model: 'stage', fallback: false });
    expect(chooseRunModel(loop, {}, { runsAfterClaim: 1 }, 6, tight)).toMatchObject({ model: 'cheap', fallback: true });
  });

  it('re-runs one model up after a fallback run that did not advance', () => {
    const ticket = { runsAfterClaim: 2, lastRunFallback: true, lastRunAdvanced: false };
    expect(chooseRunModel(loop, {}, ticket, 6, tight)).toMatchObject({ model: 'stage', fallback: false });
  });

  it('escalates on the last allowed run whatever the headroom', () => {
    expect(chooseRunModel(loop, {}, { runsAfterClaim: 6 }, 6, tight)).toEqual({
      model: 'big',
      fallback: false,
      escalated: true,
    });
  });

  it('stays on the stage model with no fallback set', () => {
    expect(chooseRunModel({ model: 'stage' }, { model: 's2' }, { runsAfterClaim: 1 }, 6, 0)).toMatchObject({
      model: 's2',
      fallback: false,
    });
  });
});
