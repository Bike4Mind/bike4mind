import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AxiosError, type AxiosAdapter, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { api, resetRefreshPromise, resetRedirectingGuard } from './ApiContext';
import { useAccessToken } from '../hooks/useAccessToken';
import { resetProbeGuardForTests, scheduleSessionRevalidation } from '../utils/sessionBootstrap';

/**
 * Reproduces issue #1691: a browser tab that stays visible/focused the whole time its access
 * token expires never recovers (repeated 401s, WS reconnect exhausts and gives up), only a
 * reload fixes it. Real ApiContext interceptors, real sessionBootstrap.probeIdentity, and a
 * real QueryClient are exercised end-to-end; only 'react-use-websocket' itself is faked, with a
 * stateful harness that transcribes the vendored fork's shared-listener reconnect scheduling
 * (see node_modules/.pnpm/react-use-websocket@.../src/lib/attach-shared-listeners.ts and
 * constants.ts - this fork's SHARED listener path is what's live here, since share:true).
 */

// vitest.setup.ts globally mocks this module for component tests that don't care about the
// real WS wiring - unmock it here so this file tests the real provider end-to-end.
vi.unmock('@/app/contexts/WebsocketContext');

// clearClientCaches touches localStorage/IndexedDB; irrelevant to the auth/WS logic under
// test, and none of these scenarios should reach the unrecoverable-401 teardown path anyway -
// stubbed defensively so a mispredicted path doesn't hang on a real IndexedDB delete.
vi.mock('@client/app/utils/clearClientCaches', () => ({ clearClientCaches: vi.fn().mockResolvedValue(undefined) }));

interface CapturedWsOptions {
  onOpen?: (event: unknown) => void;
  onClose?: (event: { code: number; reason: string }) => void;
  onReconnectStop?: (numAttempts: number) => void;
  reconnectInterval?: (attempt: number) => number;
  reconnectAttempts?: number;
}

// Shared, hoisted so the vi.mock factory below can reference it (mirrors WebsocketContext.test.ts).
const h = vi.hoisted(() => ({
  urls: [] as (string | null)[],
  lastNonNullUrl: null as string | null,
  connectAttempts: 0,
  reconnectCount: 0,
  reconnectStopCalls: 0,
  lastOptions: null as unknown as CapturedWsOptions,
}));

vi.mock('react-use-websocket', () => ({
  ReadyState: { UNINSTANTIATED: -1, CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 },
  useBaseWebsocket: (url: string | null, options: CapturedWsOptions) => {
    // Mirrors the real library's optionsCache.current = options happening on every render.
    h.lastOptions = options;
    h.urls.push(url);
    if (url === null) {
      // Mirrors use-websocket.ts's url===null branch resetting reconnectCount.current - the
      // lever WebsocketContext.tsx's refocus pulse relies on to get a fresh backoff budget.
      h.reconnectCount = 0;
    } else if (url !== h.lastNonNullUrl) {
      // A new url key means a brand new WebSocket per create-or-join.ts's
      // sharedWebSockets[url] === undefined check.
      h.lastNonNullUrl = url;
      h.connectAttempts += 1;
    }
    return { sendJsonMessage: vi.fn(), readyState: 1, lastJsonMessage: null };
  },
}));

import { WebsocketProvider } from './WebsocketContext';

/**
 * Faithful transcription of attach-shared-listeners.ts's bindCloseHandler reconnect
 * scheduling: while reconnectCount is under the budget, schedule the next attempt via a real
 * setTimeout (driven by vi.advanceTimersByTimeAsync) at options.reconnectInterval(reconnectCount);
 * on firing, bump the count and re-invoke the app's onClose (simulating that reconnect attempt's
 * own failed open), then recurse. Once the budget is exhausted, fire onReconnectStop once.
 *
 * Deliberately does NOT wrap each step in its own `act()` - nesting `act()` inside a callback
 * driven by vi.advanceTimersByTimeAsync fought the fake-timer flush and silently truncated the
 * recursion after ~14 attempts with no error. Callers wrap the whole advance in one outer
 * `act()` instead (see the tests below), which flushes every nested state update correctly.
 */
function scheduleReconnect(): void {
  const limit = h.lastOptions?.reconnectAttempts ?? 20;
  if (h.reconnectCount >= limit) {
    h.reconnectStopCalls += 1;
    h.lastOptions?.onReconnectStop?.(limit);
    return;
  }
  const delay = h.lastOptions!.reconnectInterval!(h.reconnectCount);
  setTimeout(() => {
    h.reconnectCount += 1;
    h.lastOptions?.onClose?.({ code: 1006, reason: '' });
    scheduleReconnect();
  }, delay);
}

/**
 * Simulates one native WebSocket close event: the app's onClose callback fires, then - in the
 * same handler, per the fork's bindCloseHandler - the library schedules its own reconnect.
 */
function closeAndScheduleReconnect(): void {
  h.lastOptions?.onClose?.({ code: 1006, reason: '' });
  scheduleReconnect();
}

const ok = (config: InternalAxiosRequestConfig, data: unknown): AxiosResponse =>
  ({ data, status: 200, statusText: 'OK', headers: {}, config }) as AxiosResponse;

const make401 = (config: InternalAxiosRequestConfig): AxiosError =>
  new AxiosError('Unauthorized', 'ERR_BAD_REQUEST', config, {}, {
    status: 401,
    statusText: 'Unauthorized',
    data: { error: 'Unauthorized' },
    headers: {},
    config,
  } as AxiosResponse);

// A 503 during a correlated outage - transient, not a revocation, so it must never resolve
// through the 401/refresh branch at all.
const makeStatus = (config: InternalAxiosRequestConfig, status: number): AxiosError =>
  new AxiosError(`Error ${status}`, 'ERR_BAD_RESPONSE', config, {}, {
    status,
    statusText: 'Error',
    data: {},
    headers: {},
    config,
  } as AxiosResponse);

// Scripted fake server keyed on TOKEN IDENTITY (not clock/JWT-exp claims) so it stays
// deterministic under fake timers.
let serverToken = 'tok-1';
let outage = false;
let refreshCalls = 0;

const fakeAdapter = ((config: InternalAxiosRequestConfig) => {
  if (outage) {
    return Promise.reject(makeStatus(config, 503));
  }
  if (config.url === '/api/auth/refreshToken') {
    // Refresh rides the HttpOnly cookie, not the bearer header - unconditional success.
    refreshCalls += 1;
    serverToken = 'tok-2';
    return Promise.resolve(ok(config, { accessToken: 'tok-2' }));
  }
  const authHeader = config.headers?.Authorization as string | undefined;
  if (authHeader !== `Bearer ${serverToken}`) {
    return Promise.reject(make401(config));
  }
  if (config.url === '/api/identify') {
    return Promise.resolve(ok(config, { user: { id: 'u1', preferences: {} }, accessToken: serverToken }));
  }
  return Promise.resolve(ok(config, { ok: true }));
}) as AxiosAdapter;

const stubVisibility = (state: DocumentVisibilityState) =>
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });

// Mounts the WS provider AND arms the same expiry-driven revalidation timer providers.tsx
// wires at the app root (scheduleSessionRevalidation) - the two fixes for #1691 are
// independent (FP-1 in WebsocketContext.tsx, FP-2 here) and this suite proves the COMBINED,
// as-shipped system recovers, not either half in isolation. Returns the disposer so each test
// can tear its timer down and not leak into the next.
function mount(queryClient: QueryClient): () => void {
  render(
    <QueryClientProvider client={queryClient}>
      <WebsocketProvider url="wss://example/ws">
        <div />
      </WebsocketProvider>
    </QueryClientProvider>
  );
  return scheduleSessionRevalidation(queryClient);
}

describe('focused-tab session recovery (#1691)', () => {
  const realLocation = window.location;
  let realAdapter: AxiosAdapter | undefined;
  let queryClient: QueryClient;
  let focusProbe: ReturnType<typeof vi.fn>;
  let disposeRevalidation: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);

    h.urls = [];
    h.lastNonNullUrl = null;
    h.connectAttempts = 0;
    h.reconnectCount = 0;
    h.reconnectStopCalls = 0;
    h.lastOptions = null as unknown as CapturedWsOptions;

    resetRefreshPromise();
    resetRedirectingGuard();
    resetProbeGuardForTests();

    serverToken = 'tok-1';
    outage = false;
    refreshCalls = 0;

    realAdapter = api.defaults.adapter as AxiosAdapter | undefined;
    api.defaults.adapter = fakeAdapter;

    useAccessToken.setState({ accessToken: 'tok-1', expired: false, expiredReason: null, mfaPending: false });

    stubVisibility('visible');

    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        pathname: '/app',
        search: '',
        hash: '',
        href: 'http://localhost/app',
        origin: 'http://localhost',
        replace: vi.fn(),
      },
    });

    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false },
        mutations: { retry: false },
      },
    });

    focusProbe = vi.fn();
    document.addEventListener('visibilitychange', focusProbe);
    window.addEventListener('focus', focusProbe);
  });

  afterEach(() => {
    disposeRevalidation?.();
    document.removeEventListener('visibilitychange', focusProbe);
    window.removeEventListener('focus', focusProbe);
    api.defaults.adapter = realAdapter;
    Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('an established connection dropping is not treated as an auth signal', async () => {
    disposeRevalidation = mount(queryClient);
    await act(async () => {
      h.lastOptions?.onOpen?.({});
    });

    // Only the established-drop's own onClose has run - do not advance timers, so no
    // subsequent reconnect attempt has fired yet either.
    await act(async () => {
      closeAndScheduleReconnect();
    });

    expect(refreshCalls).toBe(0);
    expect(focusProbe).not.toHaveBeenCalled();
  });

  it('the first failed reconnect attempt self-heals with zero focus events', async () => {
    disposeRevalidation = mount(queryClient);
    await act(async () => {
      h.lastOptions?.onOpen?.({});
    });

    // Server-side rotation while the store still holds the old token - the real-world case
    // this self-heal must cover (a token that expired while the tab sat focused).
    serverToken = 'rotated';

    // Established drop: openedThisAttempt was true, so no probe here (see Test 1).
    await act(async () => {
      closeAndScheduleReconnect();
    });

    // Let the first scheduled reconnect attempt (125ms) fire. That attempt's own close has
    // openedThisAttempt=false, so WebsocketContext's real onClose fires probeIdentity, which
    // 401s, refreshes, and retries.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(refreshCalls).toBe(1);
    expect(useAccessToken.getState().accessToken).toBe('tok-2');
    expect(focusProbe).not.toHaveBeenCalled();
  });

  it('budget exhausted during a correlated outage still recovers on its own, with zero focus events', async () => {
    disposeRevalidation = mount(queryClient);
    await act(async () => {
      h.lastOptions?.onOpen?.({});
    });

    // The same failure that killed the WS also breaks the API - the realistic
    // deploy/network-blip correlation this repro targets. This also correlates with
    // scheduleSessionRevalidation's OWN periodic probe (armed at mount, ~300s fallback delay
    // since these test tokens carry no real exp claim) - it will 503 too while this holds.
    serverToken = 'rotated';
    outage = true;

    await act(async () => {
      closeAndScheduleReconnect();
    });

    // Run out the full 20-attempt WS reconnect budget while the outage is active. Every failed
    // attempt's own onClose fires a probe (including the 20th, exhausting one) and every one
    // 503s and does nothing (a 503 never reaches the interceptor's 401/refresh branch at all) -
    // don't assert zero requests, assert the outcome.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400_000);
    });
    expect(useAccessToken.getState().accessToken).toBe('tok-1');
    expect(h.reconnectStopCalls).toBe(1);

    // Service recovers. The WS reconnect budget is already exhausted and nothing else in
    // WebsocketContext.tsx alone will retry - recovery here depends entirely on
    // scheduleSessionRevalidation's independent, self-re-arming timer (FP-2), which keeps
    // re-arming after every attempt (success or failure) regardless of what the WS is doing.
    outage = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    });

    // The fix: scheduleSessionRevalidation's next scheduled probe (well within this hour) lands
    // after the outage clears, refreshes the token, and WebsocketContext's accessToken-change
    // effect (the other half of FP-1) then pulses the WS back to life - all with zero focus or
    // visibilitychange events anywhere in this test.
    expect(refreshCalls).toBe(1);
    expect(useAccessToken.getState().accessToken).toBe('tok-2');
    expect(h.urls).toContain(null);
    expect(focusProbe).not.toHaveBeenCalled();
  });

  it('onReconnectStop is invoked with the real limit, not undefined', async () => {
    disposeRevalidation = mount(queryClient);
    await act(async () => {
      h.lastOptions?.onOpen?.({});
    });

    await act(async () => {
      closeAndScheduleReconnect();
      await vi.advanceTimersByTimeAsync(400_000);
    });

    // Pins the already-landed reconnectAttempts:20 fix from the WS harness's own perspective.
    expect(h.reconnectStopCalls).toBe(1);
    expect(focusProbe).not.toHaveBeenCalled();
  });
});
