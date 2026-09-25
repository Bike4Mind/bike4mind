// @vitest-environment node
import { describe, it, expect } from 'vitest';

import { acquisitionFromStripeMetadata, acquisitionToStripeMetadata, readAcquisitionTouches, stableEventId } from './acquisition';

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
    expect(t).toEqual({ firstTouch: { source: 'google', medium: 'cpc' }, lastTouch: { source: 'widgets', medium: 'teaser' } });
  });

  it('falls back to the app first touch and the session cookie', () => {
    expect(readAcquisitionTouches(cookie({ b4m_app_first_touch: { source: 'widgets' }, b4m_utm: { source: 'email' } }))).toEqual({
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

describe('Stripe metadata round trip', () => {
  it('flattens both touches into acq_* keys and reads them back', () => {
    const touches = { firstTouch: { source: 'widgets', medium: 'teaser', content: 'hero' }, lastTouch: { source: 'email', campaign: 'fall' } };
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

describe('stableEventId', () => {
  it('is a UUID-shaped id, the same for the same parts and different otherwise', () => {
    const a = stableEventId('subscribe', 'widgets', 'sub_1');
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(stableEventId('subscribe', 'widgets', 'sub_1')).toBe(a);
    expect(stableEventId('subscribe', 'widgets', 'sub_2')).not.toBe(a);
  });
});
