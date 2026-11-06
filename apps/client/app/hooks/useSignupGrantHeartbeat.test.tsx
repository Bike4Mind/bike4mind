// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const h = vi.hoisted(() => ({
  post: vi.fn(),
  invalidate: vi.fn(),
  grant: undefined as Record<string, unknown> | undefined,
  enabled: true as boolean | string | undefined,
  daily: 1000 as number | undefined,
}));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: h.post } }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: h.invalidate }) }));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: () => ({ currentUser: { id: 'u1', signupGrant: h.grant } }),
}));
vi.mock('@client/app/hooks/data/settings', () => ({
  useSettingsFromServer: () => ({
    data: [
      { settingName: 'signupGrantActivityEnabled', settingValue: h.enabled },
      { settingName: 'signupGrantDailyCredits', settingValue: h.daily },
      { settingName: 'signupGrantDripCap', settingValue: '9000' },
    ],
  }),
}));
import {
  useSignupGrantHeartbeat,
  HEARTBEAT_BACKOFF_MS,
  HEARTBEAT_IDLE_MS,
  HEARTBEAT_INTERVAL_MS,
} from './useSignupGrantHeartbeat';

const response = (data: Record<string, unknown> = {}) => ({
  data: { creditsGranted: 0, paidToday: false, withheld: false, ...data },
});
const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const touch = () => act(() => void window.dispatchEvent(new Event('keydown')));
const setHidden = (hidden: boolean) =>
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });

describe('useSignupGrantHeartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    h.post.mockReset().mockResolvedValue(response());
    h.invalidate.mockReset();
    h.enabled = true;
    h.daily = 1000;
    h.grant = { stage: 'signup', signupCredits: 1000, unlockCredits: 9000, creditsReleased: 1000 };
    setHidden(false);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not ping an untouched tab, then pings once there is input', async () => {
    renderHook(() => useSignupGrantHeartbeat());
    await advance(HEARTBEAT_INTERVAL_MS * 2);
    expect(h.post).not.toHaveBeenCalled();
    touch();
    await advance(HEARTBEAT_INTERVAL_MS);
    expect(h.post).toHaveBeenCalledTimes(1);
  });

  it('pings with the retired activity flag off while the daily amount is positive', async () => {
    h.enabled = false;
    renderHook(() => useSignupGrantHeartbeat());
    touch();
    await advance(HEARTBEAT_INTERVAL_MS);
    expect(h.post).toHaveBeenCalledTimes(1);
  });

  it('pings every interval while in use', async () => {
    renderHook(() => useSignupGrantHeartbeat());
    touch();
    await advance(HEARTBEAT_INTERVAL_MS);
    expect(h.post).toHaveBeenCalledTimes(1);
    expect(h.post).toHaveBeenCalledWith('/api/users/active-session');
    await advance(HEARTBEAT_INTERVAL_MS);
    await advance(HEARTBEAT_INTERVAL_MS);
    expect(h.post).toHaveBeenCalledTimes(3);
  });

  it('pauses while the tab is hidden and resumes when visible', async () => {
    renderHook(() => useSignupGrantHeartbeat());
    touch();
    await advance(HEARTBEAT_INTERVAL_MS);
    setHidden(true);
    await advance(HEARTBEAT_INTERVAL_MS * 3);
    expect(h.post).toHaveBeenCalledTimes(1);
    setHidden(false);
    await advance(HEARTBEAT_INTERVAL_MS);
    expect(h.post).toHaveBeenCalledTimes(2);
  });

  it('pauses after 5 minutes without input and resumes on input', async () => {
    renderHook(() => useSignupGrantHeartbeat());
    touch();
    await advance(HEARTBEAT_INTERVAL_MS);
    await advance(HEARTBEAT_IDLE_MS + HEARTBEAT_INTERVAL_MS);
    const idleCount = h.post.mock.calls.length;
    await advance(HEARTBEAT_INTERVAL_MS * 3);
    expect(h.post).toHaveBeenCalledTimes(idleCount);
    act(() => void window.dispatchEvent(new Event('keydown')));
    await advance(HEARTBEAT_INTERVAL_MS);
    expect(h.post).toHaveBeenCalledTimes(idleCount + 1);
  });

  it('stops after the day is paid and refreshes the user', async () => {
    h.post.mockResolvedValueOnce(response({ creditsGranted: 1000, paidToday: true }));
    renderHook(() => useSignupGrantHeartbeat());
    touch();
    await advance(HEARTBEAT_INTERVAL_MS);
    await advance(HEARTBEAT_INTERVAL_MS * 3);
    expect(h.post).toHaveBeenCalledTimes(1);
    expect(h.invalidate).toHaveBeenCalledWith({ queryKey: ['identify'] });
  });

  it('backs off to 5 minutes while the budget withholds, then keeps trying', async () => {
    h.post.mockResolvedValue(response({ withheld: true }));
    renderHook(() => useSignupGrantHeartbeat());
    touch();
    await advance(HEARTBEAT_INTERVAL_MS);
    await advance(HEARTBEAT_INTERVAL_MS * 2);
    expect(h.post).toHaveBeenCalledTimes(1);
    touch();
    await advance(HEARTBEAT_BACKOFF_MS);
    expect(h.post).toHaveBeenCalledTimes(2);
  });

  it('idles when another tab pinged recently', async () => {
    localStorage.setItem('b4m-signup-heartbeat-leader', JSON.stringify({ id: 'other', at: Date.now() }));
    renderHook(() => useSignupGrantHeartbeat());
    touch();
    await advance(HEARTBEAT_INTERVAL_MS);
    expect(h.post).not.toHaveBeenCalled();
  });

  it('resumes after UTC midnight once the day was paid', async () => {
    vi.setSystemTime(new Date('2026-03-01T23:57:30Z'));
    h.post.mockResolvedValueOnce(response({ creditsGranted: 1000, paidToday: true }));
    renderHook(() => useSignupGrantHeartbeat());
    touch();
    await advance(HEARTBEAT_INTERVAL_MS);
    expect(h.post).toHaveBeenCalledTimes(1);
    await advance(HEARTBEAT_INTERVAL_MS);
    expect(h.post).toHaveBeenCalledTimes(1);
    touch();
    await advance(HEARTBEAT_INTERVAL_MS);
    expect(h.post).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      'the drip already reached the cap',
      () =>
        (h.grant = {
          stage: 'signup',
          signupCredits: 1000,
          unlockCredits: 9000,
          creditsReleased: 1000,
          dripCredits: 9000,
        }),
    ],
    ['the daily credit is 0', () => (h.daily = 0)],
    ['the account has no grant', () => (h.grant = undefined)],
    [
      'the grant is unlocked',
      () => (h.grant = { stage: 'unlocked', signupCredits: 1, unlockCredits: 1, creditsReleased: 2 }),
    ],
  ])('does not ping when %s', async (_label, arrange) => {
    arrange();
    renderHook(() => useSignupGrantHeartbeat());
    touch();
    await advance(HEARTBEAT_INTERVAL_MS * 2);
    expect(h.post).not.toHaveBeenCalled();
  });

  it('asks the server for the next window even when this calendar day already paid', async () => {
    h.grant = { ...h.grant, lastDripDay: new Date().toISOString().slice(0, 10) };
    h.post.mockResolvedValueOnce(response({ paidToday: true, nextEligibleAt: Date.now() + 300_000 }));
    renderHook(() => useSignupGrantHeartbeat());
    touch();
    await advance(HEARTBEAT_INTERVAL_MS);
    expect(h.post).toHaveBeenCalledTimes(1);
    await advance(HEARTBEAT_INTERVAL_MS * 3);
    expect(h.post).toHaveBeenCalledTimes(1);
    touch();
    await advance(HEARTBEAT_INTERVAL_MS);
    expect(h.post).toHaveBeenCalledTimes(2);
  });
});
