import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import { AnomalyBanner, type AnomalyBannerProps } from './AnomalyBanner';

const theme = extendTheme({ ...getThemeConfig() });
const props: AnomalyBannerProps = {
  headline: '3 subscriptions out of step with Stripe',
  detail: 'Last checked overnight.',
  actionLabel: 'Review mismatches',
  onAction: vi.fn(),
  dismissKey: 'run-1',
};
const renderBanner = (overrides: Partial<AnomalyBannerProps> = {}) =>
  render(
    <CssVarsProvider theme={theme}>
      <AnomalyBanner {...props} {...overrides} />
    </CssVarsProvider>
  );

describe('shared AnomalyBanner', () => {
  it('shows the headline and detail and runs the action', () => {
    const onAction = vi.fn();
    renderBanner({ onAction });
    expect(screen.getByTestId('anomaly-banner')).toHaveTextContent('3 subscriptions out of step with Stripe');
    expect(screen.getByTestId('anomaly-banner')).toHaveTextContent('Last checked overnight.');
    fireEvent.click(screen.getByTestId('anomaly-banner-action-btn'));
    expect(onAction).toHaveBeenCalledOnce();
  });

  it('dismisses for this key and returns for the next one', () => {
    const { rerender } = renderBanner();
    fireEvent.click(screen.getByTestId('anomaly-banner-dismiss-btn'));
    expect(screen.queryByTestId('anomaly-banner')).toBeNull();
    rerender(
      <CssVarsProvider theme={theme}>
        <AnomalyBanner {...props} dismissKey="run-2" />
      </CssVarsProvider>
    );
    expect(screen.getByTestId('anomaly-banner')).toBeInTheDocument();
  });
});
