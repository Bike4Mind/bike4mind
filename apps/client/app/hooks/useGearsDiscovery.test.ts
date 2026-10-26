import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { GearStatus } from '@client/app/hooks/useGearsStatus';
import { FirstRunEvents } from '@bike4mind/common';
import {
  DISCOVERY_RECHECK_MS,
  DISCOVERY_SETTLE_MS,
  readDiscoveryState,
  writeDiscoveryState,
} from '@client/lib/gears/discovery';
import {
  markWhatsNewShown,
  resetWhatsNewShownForTests,
  wasGearsDiscoveryShown,
} from '@client/app/components/modals/whatsNewSession';

const DAY = 24 * 60 * 60 * 1000;

const h = vi.hoisted(() => ({
  gears: [] as GearStatus[],
  isPending: false,
  isError: false,
  user: { id: 'u1', createdAt: '' } as { id: string; createdAt: string } | null,
  streaming: false,
  pathname: '/',
  dialogOpen: false,
  navigate: vi.fn(),
  runCta: vi.fn(),
  logEvent: vi.fn(),
  refetch: vi.fn(),
  onStamped: undefined as (() => void) | undefined,
}));

vi.mock('@client/app/hooks/useVisibleGears', () => ({
  useVisibleGears: () => ({ gears: h.gears, isPending: h.isPending, isError: h.isError, refetch: h.refetch }),
}));
vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (sel: (s: { currentUser: typeof h.user }) => unknown) => sel({ currentUser: h.user }),
}));
vi.mock('@client/app/hooks/useStreamingState', () => ({
  useStreamingState: (sel: (s: { isAnyStreaming: () => boolean }) => unknown) =>
    sel({ isAnyStreaming: () => h.streaming }),
}));
vi.mock('@tanstack/react-router', () => ({
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => string }) =>
    select({ location: { pathname: h.pathname } }),
  useNavigate: () => h.navigate,
}));
vi.mock('@client/app/utils/anyDialogOpen', () => ({ isAnyModalDialogOpen: () => h.dialogOpen }));
vi.mock('@client/app/hooks/useGearCta', () => ({
  useGearCta: (onStamped?: () => void) => {
    h.onStamped = onStamped;
    return h.runCta;
  },
}));
vi.mock('@client/app/hooks/data/analytics', () => ({ useLogEvent: () => ({ mutate: h.logEvent }) }));

import { useGearsDiscovery } from './useGearsDiscovery';

const gear = (key: string, overrides: Partial<GearStatus> = {}): GearStatus =>
  ({
    key,
    kind: 'skill',
    unlocked: false,
    credits: 250,
    title: key,
    tagline: '',
    intro: '',
    cta: `Try ${key}`,
    ctaAction: `navigate:/${key}`,
    ...overrides,
  }) as GearStatus;

const settle = () => act(() => vi.advanceTimersByTime(DISCOVERY_SETTLE_MS));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 9, 26));
  localStorage.clear();
  resetWhatsNewShownForTests();
  h.gears = ['image', 'agents', 'websearch', 'video', 'models', 'slack', 'mcp'].map(k => gear(k));
  h.isPending = false;
  h.isError = false;
  h.user = { id: 'u1', createdAt: new Date().toISOString() };
  h.streaming = false;
  h.pathname = '/';
  h.dialogOpen = false;
  h.refetch.mockReset();
  h.onStamped = undefined;
  h.navigate.mockReset();
  h.runCta.mockReset().mockImplementation(() => undefined);
  h.logEvent.mockReset();
});

afterEach(() => vi.useRealTimers());

describe('useGearsDiscovery', () => {
  it('opens after the settle delay with the top 3 by priority, and records the show', () => {
    const { result } = renderHook(() => useGearsDiscovery());
    expect(result.current.open).toBe(false);
    settle();
    expect(result.current.open).toBe(true);
    expect(result.current.gears.map(g => g.key)).toEqual(['models', 'agents', 'websearch']);
    expect(readDiscoveryState('u1')).toEqual({ lastShownAt: Date.now(), dismissed: false, rotation: 3 });
    expect(wasGearsDiscoveryShown()).toBe(true);
    expect(h.logEvent).toHaveBeenCalledWith({
      type: FirstRunEvents.GEARS_DISCOVERY_SHOWN,
      metadata: { count: 3, keys: 'models,agents,websearch' },
    });
  });

  it('rotates on the next show', () => {
    writeDiscoveryState('u1', { lastShownAt: Date.now() - 4 * DAY, dismissed: false, rotation: 3 });
    const { result } = renderHook(() => useGearsDiscovery());
    settle();
    expect(result.current.gears.map(g => g.key)).toEqual(['image', 'video', 'mcp']);
  });

  it.each([
    ['status pending', () => (h.isPending = true)],
    ['status failed', () => (h.isError = true)],
    ['no user yet', () => (h.user = null)],
    ['on an admin page', () => (h.pathname = '/admin/users')],
    ['on the gears page', () => (h.pathname = '/gears')],
    [
      'inside the cooldown',
      () => writeDiscoveryState('u1', { lastShownAt: Date.now() - DAY / 2, dismissed: false, rotation: 0 }),
    ],
  ])('stays closed and writes nothing new: %s', (_label, arrange) => {
    arrange();
    const before = localStorage.getItem('gears_discovery_u1');
    const { result } = renderHook(() => useGearsDiscovery());
    settle();
    act(() => vi.advanceTimersByTime(DISCOVERY_RECHECK_MS * 3));
    expect(result.current.open).toBe(false);
    expect(localStorage.getItem('gears_discovery_u1')).toBe(before);
  });

  it('waits while another dialog is visible, then opens', () => {
    h.dialogOpen = true;
    const { result } = renderHook(() => useGearsDiscovery());
    settle();
    expect(result.current.open).toBe(false);
    h.dialogOpen = false;
    act(() => vi.advanceTimersByTime(DISCOVERY_RECHECK_MS));
    expect(result.current.open).toBe(true);
  });

  it('waits while a response streams', () => {
    h.streaming = true;
    const { result, rerender } = renderHook(() => useGearsDiscovery());
    settle();
    expect(result.current.open).toBe(false);
    h.streaming = false;
    rerender();
    expect(result.current.open).toBe(true);
  });

  it("gives up for the page load once What's New has been shown", () => {
    markWhatsNewShown();
    const { result } = renderHook(() => useGearsDiscovery());
    settle();
    act(() => vi.advanceTimersByTime(DISCOVERY_RECHECK_MS * 3));
    expect(result.current.open).toBe(false);
    expect(localStorage.getItem('gears_discovery_u1')).toBeNull();
  });

  it('select closes the modal, runs the CTA and logs the click', () => {
    const { result } = renderHook(() => useGearsDiscovery());
    settle();
    const target = result.current.gears[1];
    act(() => result.current.select(target, 1));
    expect(result.current.open).toBe(false);
    expect(h.runCta).toHaveBeenCalledWith(target);
    expect(h.logEvent).toHaveBeenCalledWith({
      type: FirstRunEvents.GEARS_DISCOVERY_CLICKED,
      metadata: { key: target.key, position: 1 },
    });
  });

  it('refreshes the gears status when a stamp gear is used from the modal', () => {
    renderHook(() => useGearsDiscovery());
    h.onStamped?.();
    expect(h.refetch).toHaveBeenCalledTimes(1);
  });

  it('dismissForever persists the flag', () => {
    const { result } = renderHook(() => useGearsDiscovery());
    settle();
    act(() => result.current.dismissForever());
    expect(result.current.open).toBe(false);
    expect(readDiscoveryState('u1').dismissed).toBe(true);
    expect(h.logEvent).toHaveBeenCalledWith({
      type: FirstRunEvents.GEARS_DISCOVERY_DISMISSED,
      metadata: { how: 'never' },
    });
  });

  it('seeAll navigates to /gears; close only closes', () => {
    const { result } = renderHook(() => useGearsDiscovery());
    settle();
    act(() => result.current.seeAll());
    expect(h.navigate).toHaveBeenCalledWith({ to: '/gears' });
    expect(h.logEvent).toHaveBeenCalledWith({
      type: FirstRunEvents.GEARS_DISCOVERY_DISMISSED,
      metadata: { how: 'see_all' },
    });
    expect(readDiscoveryState('u1').dismissed).toBe(false);
  });

  it('close logs a plain dismissal and leaves the cooldown to bring it back', () => {
    const { result } = renderHook(() => useGearsDiscovery());
    settle();
    act(() => result.current.close());
    expect(result.current.open).toBe(false);
    expect(h.logEvent).toHaveBeenCalledWith({
      type: FirstRunEvents.GEARS_DISCOVERY_DISMISSED,
      metadata: { how: 'close' },
    });
    expect(readDiscoveryState('u1').dismissed).toBe(false);
  });
});
