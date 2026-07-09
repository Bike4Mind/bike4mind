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
  apiGet: vi.fn(),
  accessTokenState: { accessToken: 'tok' as string | null, mfaPending: false },
}));

// Capture the options react-use-websocket is called with (esp. onOpen/onClose) so the test
// can drive them directly, and return a stable stub instead of opening a real socket.
vi.mock('react-use-websocket', () => ({
  ReadyState: { UNINSTANTIATED: -1, CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 },
  useBaseWebsocket: (_url: string | null, options: Record<string, (arg: unknown) => void>) => {
    h.capturedOptions.current = options;
    return { sendJsonMessage: vi.fn(), readyState: 1, lastJsonMessage: null };
  },
}));

// The probe fires through this `api` instance; isPublicPath treats only /login as public.
vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: h.apiGet },
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

describe('WebsocketProvider - onClose auth-probe wiring (single-flight + fire)', () => {
  beforeEach(() => {
    h.apiGet.mockReset();
    h.apiGet.mockResolvedValue({ data: {} });
    h.capturedOptions.current = null as unknown as Record<string, (arg: unknown) => void>;
    h.accessTokenState.accessToken = 'tok';
    h.accessTokenState.mfaPending = false;
  });

  const mount = () => {
    render(React.createElement(WebsocketProvider, { url: 'wss://example/ws' }, React.createElement('div')));
    return h.capturedOptions.current;
  };

  it('fires exactly one /api/identify probe on a failed connect attempt', async () => {
    const opts = mount();
    await act(async () => {
      opts.onClose({ code: 1006, reason: '' });
    });
    expect(h.apiGet).toHaveBeenCalledTimes(1);
    expect(h.apiGet).toHaveBeenCalledWith('/api/identify');
  });

  it('single-flights the probe across a burst of closes (one in-flight probe max)', async () => {
    let resolveGet: (v: unknown) => void = () => {};
    h.apiGet.mockReturnValue(new Promise(r => (resolveGet = r)));
    const opts = mount();
    await act(async () => {
      opts.onClose({ code: 1006 });
      opts.onClose({ code: 1006 });
    });
    expect(h.apiGet).toHaveBeenCalledTimes(1);
    await act(async () => resolveGet({}));
  });

  it('does not probe when the connection had opened this attempt (a drop is not an auth signal)', async () => {
    const opts = mount();
    await act(async () => {
      opts.onOpen({});
      opts.onClose({ code: 1006 });
    });
    expect(h.apiGet).not.toHaveBeenCalled();
  });

  it('resets the guard after settle so a later failed attempt probes again', async () => {
    const opts = mount();
    await act(async () => {
      opts.onClose({ code: 1006 });
    });
    await act(async () => {
      opts.onClose({ code: 1006 });
    });
    expect(h.apiGet).toHaveBeenCalledTimes(2);
  });
});
