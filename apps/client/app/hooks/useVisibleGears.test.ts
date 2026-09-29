import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { GearKey, GearKind, GearStatus } from './useGearsStatus';

const { statusMock, flagMock, adminFlagMock, userState } = vi.hoisted(() => ({
  statusMock: vi.fn(),
  flagMock: vi.fn(),
  adminFlagMock: vi.fn(),
  userState: { currentUser: null as { createdAt?: string } | null },
}));

vi.mock('@client/app/hooks/useGearsStatus', () => ({ useGearsStatus: statusMock }));
vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({ isFeatureEnabled: flagMock }),
}));
vi.mock('@client/app/hooks/useAdminSettingsCache', () => ({
  useAdminSettingsCache: () => ({ isFeatureEnabled: adminFlagMock }),
}));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (select: (s: typeof userState) => unknown) => select(userState),
}));

import { gearsMenuDot, useGearsNavSignal, useVisibleGears } from './useVisibleGears';

const gear = (key: GearKey, kind: GearKind, state: Partial<GearStatus> = {}): GearStatus => ({
  key,
  kind,
  unlocked: false,
  credits: 100,
  title: key,
  tagline: '',
  intro: '',
  cta: '',
  ctaAction: '',
  ...state,
});

const withGears = (gears: GearStatus[] | undefined) =>
  statusMock.mockReturnValue({ data: gears && { gears, totalUnlocked: 0 }, isPending: !gears });

const signal = () => renderHook(() => useGearsNavSignal()).result.current;

const DAY_MS = 24 * 60 * 60 * 1000;
const signedUpDaysAgo = (days: number) => {
  userState.currentUser = { createdAt: new Date(Date.now() - days * DAY_MS).toISOString() };
};

beforeEach(() => {
  vi.clearAllMocks();
  flagMock.mockReturnValue(true);
  adminFlagMock.mockReturnValue(true);
  signedUpDaysAgo(2);
});

describe('useVisibleGears', () => {
  it('drops gears whose feature is switched off on this deployment', () => {
    flagMock.mockImplementation((flag: string) => flag !== 'enableAgents');
    adminFlagMock.mockReturnValue(false);
    withGears([gear('agents', 'destination'), gear('datalakes', 'destination'), gear('projects', 'destination')]);

    const { result } = renderHook(() => useVisibleGears());
    expect(result.current.gears.map(g => g.key)).toEqual(['projects']);
  });
});

describe('useGearsNavSignal', () => {
  it('flags nothing while the status loads', () => {
    withGears(undefined);
    expect(signal()).toEqual({ startHere: false, claimableCount: 0 });
  });

  it('says Start here while a Getting Started gear is undone', () => {
    withGears([gear('projects', 'destination', { unlocked: true }), gear('published', 'destination')]);
    expect(signal().startHere).toBe(true);
  });

  it('counts the lead skill (Model Explorer) as Getting Started, but no other skill', () => {
    withGears([gear('projects', 'destination', { unlocked: true }), gear('image', 'skill')]);
    expect(signal().startHere).toBe(false);

    withGears([gear('projects', 'destination', { unlocked: true }), gear('models', 'skill')]);
    expect(signal().startHere).toBe(true);
  });

  it('stops saying Start here once the account is 30 days old, even with Getting Started unfinished', () => {
    withGears([gear('published', 'destination')]);
    signedUpDaysAgo(29);
    expect(signal().startHere).toBe(true);
    signedUpDaysAgo(31);
    expect(signal().startHere).toBe(false);
  });

  it('never says Start here without a usable signup date', () => {
    withGears([gear('published', 'destination')]);
    userState.currentUser = {};
    expect(signal().startHere).toBe(false);
    userState.currentUser = null;
    expect(signal().startHere).toBe(false);
  });

  it('keeps counting claimable rewards for an old account', () => {
    signedUpDaysAgo(400);
    withGears([gear('image', 'skill', { claimable: true })]);
    expect(signal()).toEqual({ startHere: false, claimableCount: 1 });
  });

  it('treats a paid gear as done even after its unlock lapses', () => {
    withGears([gear('agents', 'destination', { unlocked: false, claimed: true })]);
    expect(signal().startHere).toBe(false);
  });

  it('ignores an undone gear the deployment hides', () => {
    flagMock.mockImplementation((flag: string) => flag !== 'enableHearth');
    withGears([gear('projects', 'destination', { unlocked: true }), gear('hearth', 'destination')]);
    expect(signal().startHere).toBe(false);
  });

  it('counts claimable rewards across every tab', () => {
    withGears([
      gear('projects', 'destination', { unlocked: true, claimable: true }),
      gear('image', 'skill', { claimable: true }),
      gear('video', 'skill', { claimed: true }),
    ]);
    expect(signal()).toEqual({ startHere: false, claimableCount: 2 });
  });
});

describe('gearsMenuDot', () => {
  it('is green while a reward waits, even for a new account', () => {
    expect(gearsMenuDot({ startHere: true, claimableCount: 2 })).toBe('claim');
  });

  it('stands in for Start here when nothing is claimable', () => {
    expect(gearsMenuDot({ startHere: true, claimableCount: 0 })).toBe('start');
  });

  it('is absent when the row has no tag', () => {
    expect(gearsMenuDot({ startHere: false, claimableCount: 0 })).toBeNull();
  });
});
