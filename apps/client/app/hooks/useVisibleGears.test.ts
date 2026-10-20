import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { GearKey, GearKind, GearStatus } from './useGearsStatus';

const { statusMock, flagMock, adminFlagMock, userState } = vi.hoisted(() => ({
  statusMock: vi.fn(),
  flagMock: vi.fn(),
  adminFlagMock: vi.fn(),
  userState: { currentUser: null as { createdAt?: string; currentCredits?: number } | null },
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
    expect(signal()).toEqual({ startHere: false, startHereCredits: 0, claimableCount: 0 });
  });

  it('says Start here while a Getting Started gear is undone', () => {
    withGears([gear('projects', 'destination', { unlocked: true }), gear('published', 'destination')]);
    expect(signal().startHere).toBe(true);
  });

  it('totals the credits still to earn on Getting Started, and nothing else', () => {
    withGears([
      gear('projects', 'destination', { credits: 1000 }),
      gear('published', 'destination', { credits: 5000 }),
      gear('models', 'skill', { credits: 500 }),
      gear('files', 'destination', { credits: 1000, unlocked: true }),
      gear('agents', 'destination', { credits: 1000, claimed: true }),
      gear('image', 'skill', { credits: 250 }),
    ]);
    expect(signal()).toMatchObject({ startHere: true, startHereCredits: 6500 });
  });

  it('leaves a done-but-unclaimed Getting Started gear out of the credits, and counts it as claimable', () => {
    withGears([
      gear('projects', 'destination', { credits: 1000, unlocked: true, claimable: true }),
      gear('published', 'destination', { credits: 5000 }),
    ]);
    expect(signal()).toEqual({ startHere: true, startHereCredits: 5000, claimableCount: 1 });
  });

  it('shows no Start here credits once the account is too old for the tag', () => {
    signedUpDaysAgo(31);
    withGears([gear('published', 'destination', { credits: 5000 })]);
    expect(signal().startHereCredits).toBe(0);
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

  it('says Start here for an account past the window once its balance is 0 or below', () => {
    withGears([gear('published', 'destination', { credits: 5000 })]);
    for (const currentCredits of [0, -20]) {
      userState.currentUser = { createdAt: new Date(Date.now() - 400 * DAY_MS).toISOString(), currentCredits };
      expect(signal()).toMatchObject({ startHere: true, startHereCredits: 5000 });
    }
  });

  it('keeps the window for an old account that still has credits', () => {
    withGears([gear('published', 'destination')]);
    userState.currentUser = { createdAt: new Date(Date.now() - 31 * DAY_MS).toISOString(), currentCredits: 1 };
    expect(signal().startHere).toBe(false);
  });

  it('says Start here at zero credits without a usable signup date', () => {
    withGears([gear('published', 'destination', { credits: 5000 })]);
    userState.currentUser = { currentCredits: 0 };
    expect(signal()).toEqual({ startHere: true, startHereCredits: 5000, claimableCount: 0 });
  });

  it('does not say Start here when both the signup date and balance are unavailable', () => {
    withGears([gear('published', 'destination')]);
    userState.currentUser = {};
    expect(signal().startHere).toBe(false);
    userState.currentUser = null;
    expect(signal().startHere).toBe(false);
  });

  it('keeps counting claimable rewards for an old account', () => {
    signedUpDaysAgo(400);
    withGears([gear('image', 'skill', { claimable: true })]);
    expect(signal()).toEqual({ startHere: false, startHereCredits: 0, claimableCount: 1 });
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
    expect(signal()).toEqual({ startHere: false, startHereCredits: 0, claimableCount: 2 });
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
