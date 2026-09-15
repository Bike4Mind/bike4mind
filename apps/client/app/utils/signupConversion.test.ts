import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockTrackRedditEvent } = vi.hoisted(() => ({
  mockTrackRedditEvent: vi.fn(),
}));

vi.mock('./redditPixel', () => ({
  trackRedditEvent: mockTrackRedditEvent,
}));

import { trackSignupConversion } from './signupConversion';

function setCookie(name: string, value: object) {
  document.cookie = `${name}=${encodeURIComponent(JSON.stringify(value))}; path=/`;
}

function clearCookie(name: string) {
  document.cookie = `${name}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

describe('trackSignupConversion', () => {
  const mockGtag = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('gtag', mockGtag);
    clearCookie('b4m-first-touch');
    clearCookie('b4m_utm');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fires GA4 sign_up and Reddit SignUp with the method', () => {
    trackSignupConversion('password');
    expect(mockGtag).toHaveBeenCalledWith('event', 'sign_up', { method: 'password' });
    expect(mockTrackRedditEvent).toHaveBeenCalledExactlyOnceWith('SignUp');
  });

  it('stamps first-touch and session-UTM attribution from the shared cookies', () => {
    setCookie('b4m-first-touch', {
      source: 'reddit',
      medium: 'cpc',
      campaign: 'launch-v1',
      landing: '/',
      ts: 1,
    });
    setCookie('b4m_utm', { source: 'newsletter', medium: 'email' });

    trackSignupConversion('google');

    expect(mockGtag).toHaveBeenCalledWith('event', 'sign_up', {
      method: 'google',
      first_touch_source: 'reddit',
      first_touch_medium: 'cpc',
      first_touch_campaign: 'launch-v1',
      utm_source_at_signup: 'newsletter',
      utm_medium_at_signup: 'email',
    });
  });

  it('survives a malformed attribution cookie', () => {
    document.cookie = 'b4m-first-touch=not-json; path=/';
    trackSignupConversion('password');
    expect(mockGtag).toHaveBeenCalledWith('event', 'sign_up', { method: 'password' });
  });

  it('still fires the Reddit event when gtag is absent', () => {
    vi.unstubAllGlobals();
    trackSignupConversion('password');
    expect(mockGtag).not.toHaveBeenCalled();
    expect(mockTrackRedditEvent).toHaveBeenCalledExactlyOnceWith('SignUp');
  });
});
