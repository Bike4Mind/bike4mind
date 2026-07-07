import { describe, it, expect, vi } from 'vitest';

// vitest.setup.ts globally mocks this module (to avoid a real WS layer in component tests
// that transitively import the provider) - unmock it here so this file tests the real
// exported pure function.
vi.unmock('@/app/contexts/WebsocketContext');

import { shouldProbeOnFailedWsConnect } from './WebsocketContext';

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
