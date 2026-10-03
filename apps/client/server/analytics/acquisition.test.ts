// @vitest-environment node
import { describe, it, expect } from 'vitest';

import {
  acquisitionFromStripeMetadata,
  acquisitionToStripeMetadata,
  readAcquisitionTouches,
  readConsentedAcquisitionTouches,
} from './acquisition';

const cookie = (jar: Record<string, unknown>) => ({
  headers: {
    cookie: Object.entries(jar)
      .map(([k, v]) => `${k}=${encodeURIComponent(JSON.stringify(v))}`)
      .join('; '),
  },
});

describe('readAcquisitionTouches', () => {
  it('prefers the marketing first touch and the 30-day last touch', () => {
    const t = readAcquisitionTouches(
      cookie({
        'b4m-first-touch': { source: 'google', medium: 'cpc' },
        b4m_app_first_touch: { source: 'widgets' },
        b4m_last_touch: { source: 'widgets', medium: 'teaser' },
        b4m_utm: { source: 'newsletter' },
      })
    );
    expect(t).toEqual({
      firstTouch: { source: 'google', medium: 'cpc' },
      lastTouch: { source: 'widgets', medium: 'teaser' },
    });
  });

  it('falls back to the app first touch and the session cookie', () => {
    expect(
      readAcquisitionTouches(cookie({ b4m_app_first_touch: { source: 'widgets' }, b4m_utm: { source: 'email' } }))
    ).toEqual({
      firstTouch: { source: 'widgets' },
      lastTouch: { source: 'email' },
    });
  });

  it('ignores malformed cookies, touches without a source, and caps field length', () => {
    const t = readAcquisitionTouches({
      headers: {
        cookie: `b4m-first-touch=not-json; b4m_last_touch=${encodeURIComponent(JSON.stringify({ medium: 'x' }))}; b4m_utm=${encodeURIComponent(JSON.stringify({ source: 'a'.repeat(300) }))}`,
      },
    });
    expect(t.firstTouch).toBeUndefined();
    expect(t.lastTouch?.source).toHaveLength(128);
    expect(readAcquisitionTouches({ headers: {} })).toEqual({});
  });
});

describe('readConsentedAcquisitionTouches', () => {
  // Consent values are bare strings, not JSON, so they join the encoded touch jar as a raw pair.
  const withConsent = (consent: string | undefined) => {
    const jar = cookie({ b4m_last_touch: { source: 'widgets', medium: 'teaser' } }).headers.cookie;
    return { headers: { cookie: consent === undefined ? jar : `${jar}; ${consent}` } };
  };

  it('returns the touches on a granted decision', () => {
    expect(readConsentedAcquisitionTouches(withConsent('b4m_consent=granted'))).toEqual({
      lastTouch: { source: 'widgets', medium: 'teaser' },
    });
  });

  it.each([
    ['absent', undefined],
    ['denied', 'b4m_consent=denied'],
    ['unrecognised', 'b4m_consent=yes'],
  ])('returns nothing when consent is %s, though a touch is present', (_, consent) => {
    expect(readConsentedAcquisitionTouches(withConsent(consent))).toEqual({});
  });
});

describe('Stripe metadata round trip', () => {
  it('flattens both touches into acq_* keys and reads them back', () => {
    const touches = {
      firstTouch: { source: 'widgets', medium: 'teaser', content: 'hero' },
      lastTouch: { source: 'email', campaign: 'fall' },
    };
    const md = acquisitionToStripeMetadata(touches);
    expect(md).toEqual({
      acq_first_source: 'widgets',
      acq_first_medium: 'teaser',
      acq_first_content: 'hero',
      acq_last_source: 'email',
      acq_last_campaign: 'fall',
    });
    for (const k of Object.keys(md)) expect(k.length).toBeLessThanOrEqual(40);
    expect(acquisitionFromStripeMetadata({ userId: 'u1', ...md })).toEqual(touches);
  });

  it('is undefined when nothing was recorded', () => {
    expect(acquisitionToStripeMetadata({})).toEqual({});
    expect(acquisitionFromStripeMetadata({ userId: 'u1', stage: 'dev' })).toBeUndefined();
    expect(acquisitionFromStripeMetadata(null)).toBeUndefined();
  });
});
