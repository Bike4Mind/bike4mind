import { renderToStaticMarkup } from 'react-dom/server';
import type { UsageBar, UsageBreakdownRow } from '@shared/usage';
import { describe, expect, it } from 'vitest';
import { UsageBarChart } from './UsageBarChart';
import { UsageBreakdown } from './UsageBreakdown';
import { formatCredits } from './usageView';

/**
 * Rendered to a string, like this package's other component tests and for the same reason: the
 * suite runs on `node`. Enough for what these cover - which of the three states a chart shows,
 * and that it states the figure it draws.
 */
function chart(bars: UsageBar[]): string {
  return renderToStaticMarkup(
    <UsageBarChart
      title="Credits spent"
      total={formatCredits(bars.reduce((sum, bar) => sum + bar.creditsSpent, 0))}
      bars={bars}
      granularity="day"
      metric="creditsSpent"
      color="primary"
      format={formatCredits}
      emptyMessage="No credits spent in the last 30 days."
      testId="profile-credits-chart"
    />
  );
}

const DAYS: UsageBar[] = [
  { startsAt: '2026-10-05T00:00:00.000Z', creditsSpent: 0, requests: 0 },
  { startsAt: '2026-10-06T00:00:00.000Z', creditsSpent: 400, requests: 8 },
  { startsAt: '2026-10-07T00:00:00.000Z', creditsSpent: 200, requests: 4 },
];

describe('UsageBarChart', () => {
  it('states the window total beside the bars it drew', () => {
    expect(chart(DAYS)).toContain('600');
  });

  it('scales the bars against the tallest, not against the balance', () => {
    const html = chart(DAYS);
    expect(html).toContain('height:100%');
    expect(html).toContain('height:50%');
  });

  // A window that spent nothing is a real answer, and must not read like a failed load.
  it('says a window spent nothing rather than drawing a flat row of bars', () => {
    const html = chart([{ startsAt: '2026-10-07T00:00:00.000Z', creditsSpent: 0, requests: 0 }]);
    expect(html).toContain('No credits spent in the last 30 days.');
    expect(html).toContain('profile-credits-chart-empty');
  });
});

describe('UsageBreakdown', () => {
  const rows: UsageBreakdownRow[] = [
    { key: 'anthropic:claude-opus-5', label: 'claude-opus-5', detail: 'anthropic', creditsSpent: 500, requests: 9 },
    { key: 'openai:gpt-5', label: 'gpt-5', detail: 'openai', creditsSpent: 100, requests: 2 },
  ];

  it('names what spent the credits, with the provider beside it', () => {
    const html = renderToStaticMarkup(
      <UsageBreakdown title="By model" caption="Credits charged." rows={rows} testId="profile-model-breakdown" />
    );
    expect(html).toContain('claude-opus-5');
    expect(html).toContain('anthropic');
    expect(html).toContain('500');
  });

  it('says nothing was recorded rather than drawing an empty frame', () => {
    const html = renderToStaticMarkup(
      <UsageBreakdown title="By model" caption="Credits charged." rows={[]} testId="profile-model-breakdown" />
    );
    expect(html).toContain('Nothing recorded in this window.');
  });
});
