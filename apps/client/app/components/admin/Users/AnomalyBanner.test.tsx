import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import { AnomalyBanner } from './AnomalyBanner';

const theme = extendTheme({ ...getThemeConfig() });
const snapshot = {
  since: '2026-10-27T11:00:00.000Z',
  until: '2026-10-27T12:00:00.000Z',
  signupCount: 212,
  apiKeyCount: 3,
  signupSpike: false,
  apiKeySpike: false,
  truncated: false,
  topDomain: 'example.test',
};
const renderBanner = (value: typeof snapshot, onReview = vi.fn()) =>
  render(
    <CssVarsProvider theme={theme}>
      <AnomalyBanner snapshot={value} onReview={onReview} />
    </CssVarsProvider>
  );

describe('AnomalyBanner', () => {
  it('stays hidden while nothing is abnormal', () => {
    renderBanner(snapshot);
    expect(screen.queryByTestId('users-anomaly-banner')).toBeNull();
  });

  it('names the spike and opens the cluster review', () => {
    const onReview = vi.fn();
    renderBanner({ ...snapshot, signupSpike: true }, onReview);
    expect(screen.getByTestId('users-anomaly-banner')).toHaveTextContent(
      'Signup spike: 212 new accounts in the last hour, mostly @example.test'
    );
    fireEvent.click(screen.getByTestId('users-review-cluster-btn'));
    expect(onReview).toHaveBeenCalledOnce();
  });

  it('dismisses for this window and returns for the next one', () => {
    const { rerender } = renderBanner({ ...snapshot, apiKeySpike: true });
    fireEvent.click(screen.getByTestId('users-dismiss-anomaly-btn'));
    expect(screen.queryByTestId('users-anomaly-banner')).toBeNull();
    rerender(
      <CssVarsProvider theme={theme}>
        <AnomalyBanner
          snapshot={{ ...snapshot, apiKeySpike: true, since: '2026-10-27T12:00:00.000Z' }}
          onReview={vi.fn()}
        />
      </CssVarsProvider>
    );
    expect(screen.getByTestId('users-anomaly-banner')).toBeInTheDocument();
  });
});
