// @vitest-environment jsdom
// End-to-end over the cookie seam: a marketing CTA lands on /register with UTMs, the browser's
// capture (app/utils/utmCapture.ts) writes the touch cookies, the emailed one-time-code step
// (send -> verify) is two same-origin requests that carry the cookie jar, and the verify handler's
// recordSignupAcquisition reads it back. jsdom stands in for the browser half; the server half
// reads exactly the Cookie header that jar would produce.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockConsent, mockUserUpdate } = vi.hoisted(() => ({ mockConsent: vi.fn(), mockUserUpdate: vi.fn() }));
vi.mock('@client/app/utils/consentRegion', () => ({ resolveConsent: mockConsent }));
vi.mock('./emitActiveEvent', () => ({ HOST_PRODUCT_ID: 'bike4mind', emitProductEvent: vi.fn() }));
vi.mock('@server/utils/config', () => ({ Config: { OVERWATCH_PSEUDONYM_SALT: 'test-salt' } }));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { getSettingsValue: vi.fn().mockResolvedValue('') },
  userRepository: { update: mockUserUpdate },
  User: { updateOne: vi.fn() },
}));

import { APP_DECISION_COOKIE } from '@client/lib/consentCookies';
import { captureUtmParams, clearAttributionCookies, flushUtmCapture } from '@client/app/utils/utmCapture';
import { recordSignupAcquisition } from './funnel';

const LANDING = '/register?utm_source=bike4mind.com&utm_medium=site&utm_campaign=pricing&utm_content=hero_cta';
const user = { id: 'u1', username: 'alice', email: 'alice@real.com' };

// What the verify POST carries: the jar the capture wrote, plus the consent decision the app's
// banner publishes to this origin (the decision itself lives in localStorage).
const verifyRequest = (decision?: 'granted' | 'denied') => ({
  headers: { cookie: [document.cookie, decision && `${APP_DECISION_COOKIE}=${decision}`].filter(Boolean).join('; ') },
});

beforeEach(() => {
  vi.clearAllMocks();
  clearAttributionCookies();
  mockUserUpdate.mockResolvedValue(null);
  window.history.replaceState({}, '', LANDING);
});

describe('marketing CTA -> /register -> OTC send -> verify', () => {
  it('persists the landing UTMs on the new user when consent is granted', async () => {
    mockConsent.mockReturnValue('granted');
    captureUtmParams();
    // The send-code step and the route change to the code entry do not touch the jar.
    window.history.replaceState({}, '', '/register');

    await recordSignupAcquisition({ req: verifyRequest('granted'), user, method: 'otc' });

    const touch = { source: 'bike4mind.com', medium: 'site', campaign: 'pricing', content: 'hero_cta' };
    expect(mockUserUpdate).toHaveBeenCalledWith({
      id: 'u1',
      acquisition: { firstTouch: touch, lastTouch: touch, signupMethod: 'otc', capturedAt: expect.any(Date) },
    });
  });

  it('holds the capture until the visitor accepts, then still attributes the signup', async () => {
    mockConsent.mockReturnValue('unset');
    captureUtmParams();
    expect(document.cookie).toBe('');

    mockConsent.mockReturnValue('granted');
    flushUtmCapture();
    await recordSignupAcquisition({ req: verifyRequest('granted'), user, method: 'otc' });

    expect(mockUserUpdate.mock.calls[0][0].acquisition.firstTouch.campaign).toBe('pricing');
  });

  it('stores nothing when the visitor declines', async () => {
    mockConsent.mockReturnValue('denied');
    captureUtmParams();

    const out = await recordSignupAcquisition({ req: verifyRequest('denied'), user, method: 'otc' });

    expect(out.acquisition).toBeUndefined();
    expect(mockUserUpdate).not.toHaveBeenCalled();
  });

  it('stores nothing when the server sees no granted decision, even with touch cookies present', async () => {
    mockConsent.mockReturnValue('granted');
    captureUtmParams();

    await recordSignupAcquisition({ req: verifyRequest(), user, method: 'otc' });

    expect(mockUserUpdate).not.toHaveBeenCalled();
  });
});
