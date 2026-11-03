import { describe, expect, it } from 'vitest';
import {
  describeMetric,
  formatMetricDelta,
  formatMetricValue,
  METRIC_FAMILIES,
  metricMeaning,
  metricSignal,
  modelDisplayName,
} from './businessMetricLabels';

describe('business metric labels', () => {
  it.each([
    ['verifiedSignups', 'Verified signups', 'count'],
    ['activeUsers', 'Active users', 'count'],
    ['payingSubscribers', 'Paying subscribers', 'count'],
    ['spendUsd', 'Estimated provider spend', 'usd'],
    ['spendUsd:anthropic', 'Estimated Anthropic spend', 'usd'],
    ['spendUsd:openai', 'Estimated OpenAI spend', 'usd'],
    ['spendUsd:voyage', 'Estimated Voyage spend', 'usd'],
    ['credits', 'Credits charged', 'credits'],
    ['requests:user', 'API requests (third-party keys)', 'count'],
    ['requests:firstParty', 'API requests (CLI and desktop)', 'count'],
    ['requests:unclassified', 'API requests (unstamped source)', 'count'],
    ['completions:user', 'API completions (third-party keys)', 'count'],
    ['revenueMinor:usd', 'Stripe receipts (USD)', 'minor'],
    ['somethingNew', 'somethingNew', 'count'],
  ])('labels %s as "%s" in %s', (name, label, unit) => {
    expect(describeMetric(name)).toMatchObject({ label, unit });
  });

  it('formats counts whole, credits with their unit and money with a currency code', () => {
    expect(formatMetricValue(1234.6, describeMetric('activeUsers'))).toBe('1,235');
    expect(formatMetricValue(2667, describeMetric('credits'))).toBe('2,667 credits');
    expect(formatMetricValue(2958.4, describeMetric('spendUsd'))).toBe('USD 2,958.40');
    expect(formatMetricValue(123456, describeMetric('revenueMinor:eur'))).toBe('EUR 1,234.56');
    expect(formatMetricDelta(-1, describeMetric('verifiedSignups'))).toBe('-1');
    expect(formatMetricDelta(12.3, describeMetric('spendUsd:openai'))).toBe('+USD 12.30');
  });

  it('gives every family a meaning and a signal in both directions', () => {
    for (const [family, entry] of Object.entries(METRIC_FAMILIES)) {
      expect(entry.meaning.increase.length).toBeGreaterThan(20);
      expect(entry.meaning.decrease.length).toBeGreaterThan(20);
      expect(metricMeaning(`${family}:cut`, 'increase')).toBe(entry.meaning.increase);
    }
    expect(metricSignal('verifiedSignups', 'increase')).toBe('abuse');
    expect(metricSignal('credits', 'increase')).toBe('abuse');
    expect(metricSignal('requests:user', 'increase')).toBe('abuse');
    expect(metricSignal('payingSubscribers', 'increase')).toBe('growth');
    expect(metricSignal('spendUsd', 'decrease')).toBe('dip');
    expect(metricSignal('unknown', 'decrease')).toBe('dip');
  });

  it.each([
    ['claude-opus-5-5', 'Claude Opus 5.5'],
    ['global.anthropic.claude-haiku-5-5', 'Claude Haiku 5.5'],
    ['us.anthropic.claude-sonnet-4-5', 'Claude Sonnet 4.5'],
    ['claude-haiku-4-5-20251001', 'Claude Haiku 4.5'],
    ['us.anthropic.claude-opus-4-1-20250805-v1:0', 'Claude Opus 4.1'],
    ['eu.anthropic.claude-sonnet-4-5-20250929-v2', 'Claude Sonnet 4.5'],
    ['claude-sonnet-5', 'Claude Sonnet 5'],
    ['gpt-5-4-mini', 'GPT-5.4 Mini'],
    ['gpt-4.1', 'GPT-4.1'],
    ['gpt-4o', 'GPT-4o'],
    ['gpt-image-1', 'GPT Image 1'],
    ['gemini-2.5-pro', 'Gemini 2.5 Pro'],
    ['dall-e-3', 'Dall E 3'],
    ['', ''],
  ])('names %s "%s"', (id, name) => {
    expect(modelDisplayName(id)).toBe(name);
  });
});
