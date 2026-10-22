import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

let stored: Record<string, unknown> = {};
vi.mock('./settings', () => ({
  useGetSettingsValue: (key: string) => stored[key],
}));

import {
  useLowCreditsThreshold,
  useTeamPlanAvailable,
  useTeamCreditsPerSeat,
  useTeamSeatLimits,
} from './teamPlanSettings';

beforeEach(() => {
  stored = {};
});

describe('team plan setting hooks', () => {
  it('fall back to the historical constants while nothing is stored', () => {
    expect(renderHook(() => useTeamSeatLimits()).result.current).toEqual({ minSeats: 4, maxSeats: 100 });
    expect(renderHook(() => useTeamCreditsPerSeat()).result.current).toBe(50000);
    expect(renderHook(() => useLowCreditsThreshold()).result.current).toBe(1000);
  });

  it('read stored values (settings arrive as strings or numbers)', () => {
    stored = {
      teamPlanMinSeats: '2',
      teamPlanMaxSeats: 40,
      teamPlanCreditsPerSeat: '60000',
      lowCreditsThreshold: '250',
    };
    expect(renderHook(() => useTeamSeatLimits()).result.current).toEqual({ minSeats: 2, maxSeats: 40 });
    expect(renderHook(() => useTeamCreditsPerSeat()).result.current).toBe(60000);
    expect(renderHook(() => useLowCreditsThreshold()).result.current).toBe(250);
  });

  it('resolve a floor above the ceiling the same way the server does', () => {
    stored = { teamPlanMinSeats: 50, teamPlanMaxSeats: 10 };
    expect(renderHook(() => useTeamSeatLimits()).result.current).toEqual({ minSeats: 10, maxSeats: 10 });
  });
});

describe('useTeamPlanAvailable', () => {
  it.each([
    [true, true],
    [false, false],
    ['true', true],
    ['TRUE', true],
    ['false', false],
    ['FALSE', false],
    ['1', true],
    ['0', false],
    [1, true],
    [0, false],
    [undefined, false],
    [null, false],
    ['', false],
    ['yes', false],
    ['01', false],
    [' 1 ', false],
    [2, false],
    [-1, false],
    [{}, false],
    [[], false],
  ])('maps the raw setting %j to %s, as the setting schema does', (raw, expected) => {
    stored = { enableTeamPlan: raw };
    expect(renderHook(() => useTeamPlanAvailable()).result.current).toBe(expected);
  });
});
