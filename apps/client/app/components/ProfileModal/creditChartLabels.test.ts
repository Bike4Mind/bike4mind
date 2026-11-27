import { describe, expect, it } from 'vitest';
import { getCreditSeriesLabel } from './creditChartLabels';

const t = (key: string) => `t:${key}`;

describe('getCreditSeriesLabel', () => {
  it.each([
    ['referral_rewards', 'Referral rewards'],
    ['credits_added', 'Credits Added'],
    ['generic_add', 'Generic Credits Added'],
    ['purchases', 'Purchases'],
    ['text_usage', 'Text Generation'],
  ])('names the %s series', (seriesId, label) => {
    expect(getCreditSeriesLabel(seriesId, t)).toBe(label);
  });

  it('translates the usage series and falls back to the credits label', () => {
    expect(getCreditSeriesLabel('usage', t)).toBe('t:credits.credits_used');
    expect(getCreditSeriesLabel('something_new', t)).toBe('t:credits.credits');
  });
});
