import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, act } from '@testing-library/react';

// vitest.setup.ts globally mocks this module (to avoid a real WS layer in component tests
// that transitively import the provider) - unmock it here so this file tests the real
// exported pure function AND the real provider.
vi.unmock('@/app/contexts/WebsocketContext');

// Shared, hoisted so the vi.mock factories below can reference them.
const h = vi.hoisted(() => ({
  capturedOptions: { current: null as unknown as Record<string, (arg: unknown) => void> },
  capturedUrls: [] as (string | null)[],
  readyState: 1 as number, // ReadyState.OPEN
  probeIdentity: vi.fn(),
  queryClient: {} as unknown,
  accessTokenState: { accessToken: 'tok' as string | null, mfaPending: false },
}));

// Capture the url + options react-use-websocket is called with on every render (esp.
// onOpen/onClose, and whether url dips to null - the reconnect-pulse signal) and return a
// stable stub instead of opening a real socket.
vi.mock('react-use-websocket', () => ({
  ReadyState: { UNINSTANTIATED: -1, CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 },
  useBaseWebsocket: (url: string | null, options: Record<string, (arg: unknown) => void>) => {
    h.capturedOptions.current = options;
    h.capturedUrls.push(url);
    return { sendJsonMessage: vi.fn(), readyState: h.readyState, lastJsonMessage: null };
  },
}));

vi.mock('@tanstack/react-query', async importOriginal => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => h.queryClient,
}));

// The close-probe and the refocus reconnect-pulse both funnel through this shared,
// single-flight helper (tested on its own in sessionBootstrap.test.ts) - mocked here so
// this file tests only WebsocketContext's own wiring, not probeIdentity's internals.
vi.mock('@client/app/utils/sessionBootstrap', () => ({
  probeIdentity: h.probeIdentity,
}));

// isPublicPath treats only /login as public.
vi.mock('@client/app/contexts/ApiContext', () => ({
  isPublicPath: (p: string) => p === '/login',
}));

// useAccessToken is both a selector hook and a store with getState().
vi.mock('@client/app/hooks/useAccessToken', () => {
  const useAccessToken = ((selector: (s: typeof h.accessTokenState) => unknown) =>
    selector(h.accessTokenState)) as unknown as {
    (selector: (s: typeof h.accessTokenState) => unknown): unknown;
    getState: () => typeof h.accessTokenState;
  };
  useAccessToken.getState = () => h.accessTokenState;
  return { useAccessToken };
});

import { shouldProbeOnFailedWsConnect, WebsocketProvider } from './WebsocketContext';

const base = { openedThisAttempt: false, accessToken: 'tok', mfaPending: false, pathname: '/new' };

const stubVisibility = (state: DocumentVisibilityState) =>
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });

describe('shouldProbeOnFailedWsConnect - WS connect-failure auth probe gate (Part 2, reuses Fix B)', () => {
  it('probes on a failed connect ATTEMPT while holding a token', () => {
    expect(shouldProbeOnFailedWsConnect(base)).toBe(true);
  });

  it('does not probe when the connection had opened (an established connection dropping is not an auth signal)', () => {
    expect(shouldProbeOnFailedWsConnect({ ...base, openedThisAttempt: true })).toBe(false);
  });

  it('does not probe when there is no access token (logged-out tab)', () => {
    expect(shouldProbeOnFailedWsConnect({ ...base, accessToken: null })).toBe(false);
  });

  it('does not probe during mfaPending (no refresh token by design - mirrors ApiContext)', () => {
    expect(shouldProbeOnFailedWsConnect({ ...base, mfaPending: true })).toBe(false);
  });

  it('does not probe on a public path', () => {
    expect(shouldProbeOnFailedWsConnect({ ...base, pathname: '/login' })).toBe(false);
  });
});

describe('WebsocketProvider - onClose auth-probe wiring', () => {
  beforeEach(() => {
    h.probeIdentity.mockReset();
    h.probeIdentity.mockResolvedValue(undefined);
    h.capturedOptions.current = null as unknown as Record<string, (arg: unknown) => void>;
    h.capturedUrls = [];
    h.readyState = 1;
    h.accessTokenState.accessToken = 'tok';
    h.accessTokenState.mfaPending = false;
    stubVisibility('visible');
  });

  const mount = () => {
    render(React.createElement(WebsocketProvider, { url: 'wss://example/ws' }, React.createElement('div')));
    return h.capturedOptions.current;
  };

  it('fires probeIdentity with the shared query client on a failed connect attempt', async () => {
    const opts = mount();
    await act(async () => {
      opts.onClose({ code: 1006, reason: '' });
    });
    expect(h.probeIdentity).toHaveBeenCalledTimes(1);
    expect(h.probeIdentity).toHaveBeenCalledWith(h.queryClient);
  });

  it('does not probe when the connection had opened this attempt (a drop is not an auth signal)', async () => {
    const opts = mount();
    await act(async () => {
      opts.onOpen({});
      opts.onClose({ code: 1006 });
    });
    expect(h.probeIdentity).not.toHaveBeenCalled();
  });

  it("fires again on a later failed attempt (dedup across a burst is probeIdentity's own job, tested separately)", async () => {
    const opts = mount();
    await act(async () => {
      opts.onClose({ code: 1006 });
    });
    await act(async () => {
      opts.onClose({ code: 1006 });
    });
    expect(h.probeIdentity).toHaveBeenCalledTimes(2);
  });
});

describe('WebsocketProvider - reconnect budget option', () => {
  beforeEach(() => {
    h.capturedOptions.current = null as unknown as Record<string, (arg: unknown) => void>;
    h.capturedUrls = [];
    h.readyState = 1;
    h.accessTokenState.accessToken = 'tok';
    h.accessTokenState.mfaPending = false;
    stubVisibility('visible');
  });

  it('passes reconnectAttempts explicitly, so onReconnectStop logs the real limit instead of undefined', () => {
    render(React.createElement(WebsocketProvider, { url: 'wss://example/ws' }, React.createElement('div')));
    expect((h.capturedOptions.current as unknown as { reconnectAttempts: number }).reconnectAttempts).toBe(20);
  });
});

describe('WebsocketProvider - refocus reconnect pulse', () => {
  beforeEach(() => {
    h.probeIdentity.mockReset();
    h.probeIdentity.mockResolvedValue(undefined);
    h.capturedOptions.current = null as unknown as Record<string, (arg: unknown) => void>;
    h.capturedUrls = [];
    h.readyState = 1;
    h.accessTokenState.accessToken = 'tok';
    h.accessTokenState.mfaPending = false;
    stubVisibility('visible');
  });

  const mount = () => {
    render(React.createElement(WebsocketProvider, { url: 'wss://example/ws' }, React.createElement('div')));
    return h.capturedOptions.current;
  };

  it('pulses the url to null and back on refocus once the reconnect budget is exhausted', async () => {
    const opts = mount();
    await act(async () => {
      opts.onReconnectStop(20); // the budget genuinely ran out - no pending backoff timer left
    });
    h.capturedUrls = [];

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // The pulse dips the url to null for one commit (resetting react-use-websocket's own
    // reconnectCount) then straight back to the real url, so both appear in the sequence.
    expect(h.capturedUrls).toContain(null);
    expect(h.capturedUrls[h.capturedUrls.length - 1]).toBe('wss://example/ws');
  });

  it('does not pulse on refocus while still mid-backoff (budget not yet exhausted)', async () => {
    mount(); // no onReconnectStop - a reconnect attempt may still be pending its own backoff
    h.capturedUrls = [];

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(h.capturedUrls).not.toContain(null);
  });

  it('does not pulse on refocus when the socket is open', async () => {
    const opts = mount();
    await act(async () => {
      opts.onOpen({});
    });
    h.capturedUrls = [];

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(h.capturedUrls).not.toContain(null);
  });

  it('a successful reconnect clears the exhausted flag, so a later refocus does not pulse again', async () => {
    const opts = mount();
    await act(async () => {
      opts.onReconnectStop(20);
      opts.onOpen({});
    });
    h.capturedUrls = [];

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(h.capturedUrls).not.toContain(null);
  });

  it('does not pulse when the tab is backgrounded (only a return to visible should)', async () => {
    const opts = mount();
    await act(async () => {
      opts.onReconnectStop(20);
    });
    h.capturedUrls = [];
    stubVisibility('hidden');

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(h.capturedUrls).not.toContain(null);
  });
});

describe('WebsocketProvider - reconnect recovery on a token change (no focus event needed)', () => {
  beforeEach(() => {
    h.probeIdentity.mockReset();
    h.probeIdentity.mockResolvedValue(undefined);
    h.capturedOptions.current = null as unknown as Record<string, (arg: unknown) => void>;
    h.capturedUrls = [];
    h.readyState = 1;
    h.accessTokenState.accessToken = 'tok';
    h.accessTokenState.mfaPending = false;
    stubVisibility('visible');
  });

  // A tab that never blurs never sends the visibilitychange/focus event the pulse above
  // relies on - a token refresh (from ANY path: the exhausting attempt's own onClose probe,
  // scheduleSessionRevalidation's timer, a reactive 401 refresh) is the only signal such a tab
  // can produce. This covers the FP-1 fix: once the reconnect budget is exhausted, a token
  // change alone must still reset it.
  it('pulses the reconnect budget when the access token changes after exhaustion, with zero focus events', async () => {
    const rendered = render(
      React.createElement(WebsocketProvider, { url: 'wss://example/ws' }, React.createElement('div'))
    );
    const opts = h.capturedOptions.current;
    await act(async () => {
      opts.onReconnectStop(20);
    });
    h.capturedUrls = [];

    h.accessTokenState.accessToken = 'tok-2';
    await act(async () => {
      rendered.rerender(
        React.createElement(WebsocketProvider, { url: 'wss://example/ws' }, React.createElement('div'))
      );
    });

    // The pulse dips the url to null for one commit (resetting react-use-websocket's own
    // reconnectCount) then straight back, carrying the fresh token in queryParams.
    expect(h.capturedUrls).toContain(null);
    expect(h.capturedUrls[h.capturedUrls.length - 1]).toBe('wss://example/ws');
    expect((h.capturedOptions.current as unknown as { queryParams: { token: string } }).queryParams.token).toBe(
      'tok-2'
    );
  });

  it('does not pulse on a genuine token change while the budget is not exhausted', async () => {
    const rendered = render(
      React.createElement(WebsocketProvider, { url: 'wss://example/ws' }, React.createElement('div'))
    );
    h.capturedUrls = [];

    h.accessTokenState.accessToken = 'tok-2';
    await act(async () => {
      rendered.rerender(
        React.createElement(WebsocketProvider, { url: 'wss://example/ws' }, React.createElement('div'))
      );
    });

    expect(h.capturedUrls).not.toContain(null);
  });

  // The pulse hands the socket a fresh reconnect budget immediately, not only once it opens -
  // otherwise a second trigger (another token change, or a refocus) landing anywhere in that
  // still-connecting window would pulse AGAIN mid-backoff: the exact stale-timer/thundering-herd
  // case the pulse's own guard comment warns against, and onOpen never fires to clear the guard
  // if the reconnect fails again.
  it('does not pulse a second time from a token change landing mid-backoff, before the pulsed attempt opens', async () => {
    const rendered = render(
      React.createElement(WebsocketProvider, { url: 'wss://example/ws' }, React.createElement('div'))
    );
    const opts = h.capturedOptions.current;
    await act(async () => {
      opts.onReconnectStop(20);
    });

    h.accessTokenState.accessToken = 'tok-2';
    await act(async () => {
      rendered.rerender(
        React.createElement(WebsocketProvider, { url: 'wss://example/ws' }, React.createElement('div'))
      );
    });
    h.capturedUrls = [];

    // No onOpen in between - the pulsed attempt is still connecting when a second change lands.
    h.accessTokenState.accessToken = 'tok-3';
    await act(async () => {
      rendered.rerender(
        React.createElement(WebsocketProvider, { url: 'wss://example/ws' }, React.createElement('div'))
      );
    });

    expect(h.capturedUrls).not.toContain(null);
  });
});
