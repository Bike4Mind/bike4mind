import { describe, expect, it } from 'vitest';
import { accessSummary, modelTypeLabel, priceSummary, sunsetDistance } from './modelPresentation';

const access = (overrides: Partial<Parameters<typeof accessSummary>[0]> = {}) => ({
  entry: null,
  everyone: true,
  adminsOnly: false,
  freeTierLocked: false,
  ...overrides,
});
const entry = (fields: { enabled?: boolean; allowedUserTags?: string[]; allowedEntitlements?: string[] }) => ({
  enabled: true,
  allowedUserTags: [],
  allowedEntitlements: [],
  ...fields,
});

describe('accessSummary', () => {
  it('reads an enabled model with no tags and no entitlements as the Admins only hazard', () => {
    expect(accessSummary(access({ entry: entry({}), everyone: false, adminsOnly: true }))).toEqual({
      label: 'Admins only',
      tone: 'bad',
      adminsOnly: true,
    });
  });

  it('names who can pick a restricted model', () => {
    const summary = accessSummary(
      access({ entry: entry({ allowedUserTags: ['a', 'b'], allowedEntitlements: ['pro'] }), everyone: false })
    );
    expect(summary.label).toBe('pro + 2 tags');
  });

  it('reads Off before anything else, and adds a free-tier lock to Everyone', () => {
    expect(accessSummary(access({ entry: entry({ enabled: false }) })).label).toBe('Off');
    expect(accessSummary(access({ freeTierLocked: true })).label).toBe('Everyone, free tier locked');
  });
});

describe('priceSummary', () => {
  it('shows a token price per 1M in and out', () => {
    const price = {
      source: 'row' as const,
      unit: 'per_token' as const,
      pricing: { '0': { input: 2.5e-6, output: 1e-5 } },
      effectiveFrom: '',
    };
    expect(priceSummary(price, 'text')).toBe('$2.50 / $10.00');
  });

  it('shows an image price per image and a non-text build literal by source', () => {
    const tier = { '0': { input: 0.04, output: 0 } };
    expect(priceSummary({ source: 'row', unit: 'per_image', pricing: tier, effectiveFrom: '' }, 'image')).toBe(
      '$0.04 / image'
    );
    expect(priceSummary({ source: 'build', pricing: tier }, 'image')).toBe('Build table');
    expect(priceSummary(null, 'text')).toBe('-');
  });
});

describe('modelTypeLabel', () => {
  it('labels every type the server sends', () => {
    expect(modelTypeLabel('text')).toBe('Text');
    expect(modelTypeLabel('speech-to-text')).toBe('Speech to text');
    expect(modelTypeLabel('realtime-voice')).toBe('Realtime voice');
  });
});

describe('sunsetDistance', () => {
  it('reads days left, today, and days past', () => {
    expect(sunsetDistance(20)).toBe('in 20 days');
    expect(sunsetDistance(1)).toBe('in 1 day');
    expect(sunsetDistance(0)).toBe('today');
    expect(sunsetDistance(-1)).toBe('1 day ago');
    expect(sunsetDistance(-17)).toBe('17 days ago');
  });
});
