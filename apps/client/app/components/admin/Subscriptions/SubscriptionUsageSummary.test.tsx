import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import type { SubscriptionUsage } from '@bike4mind/server-utils/app/utils/subscriptionUsage';
vi.mock('@client/app/contexts/ApiContext', () => ({ api: {} }));
import { SubscriptionUsageObservation } from './SubscriptionUsageSummary';

const theme = extendTheme({ ...getThemeConfig() });
const observation: SubscriptionUsage = {
  from: '2026-05-18',
  to: '2026-06-15',
  queriedAt: '2026-06-15',
  recordedSince: null,
  latestRecordedAt: null,
  coverage: 'unknown',
  firstPartyRequests: null,
  apiRequests: null,
  creditsConsumed: null,
  lastSuccessfulAt: null,
  successfulRequests: 0,
  recordedEvents: 0,
};
const show = (usage?: SubscriptionUsage) =>
  render(
    <CssVarsProvider theme={theme}>
      <SubscriptionUsageObservation usage={usage} />
    </CssVarsProvider>
  );
describe('subscriber usage summary', () => {
  it('shows unavailable without invented zeroes', () => {
    show();
    expect(screen.getByText('Usage unavailable')).toBeInTheDocument();
  });
  it('labels unknown metrics, observation window and freshness', () => {
    show(observation);
    const text = screen.getByTestId('subscription-usage-observation').textContent;
    expect(text).toContain('Unknown first-party / Unknown API');
    expect(text).toContain('Window: 2026-05-18 to 2026-06-15');
    expect(text).toContain('Latest stored event: Unknown');
    expect(text).toContain('Excluded from follow-up cohorts');
  });
  it('describes empty observations without predicting inactivity', () => {
    show({ ...observation, coverage: 'observed', firstPartyRequests: 0, apiRequests: 0, creditsConsumed: 0 });
    expect(screen.getByTestId('subscription-usage-observation').textContent).toContain('not proof of inactivity');
  });
});
