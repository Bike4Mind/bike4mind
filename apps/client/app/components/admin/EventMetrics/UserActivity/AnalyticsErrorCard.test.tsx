import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import { AnalyticsErrorCard } from './AnalyticsErrorCard';

const theme = extendTheme({ ...getThemeConfig() });

describe('AnalyticsErrorCard', () => {
  it('announces the failure with its message and retries on request', () => {
    const onRetry = vi.fn();
    render(
      <CssVarsProvider theme={theme}>
        <AnalyticsErrorCard
          error={new Error('502 Bad Gateway')}
          onRetry={onRetry}
          title="Could not load user activity"
          testId="ua-error"
        />
      </CssVarsProvider>
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Could not load user activity: 502 Bad Gateway');
    expect(screen.getByTestId('ua-error')).toContainElement(alert);
    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('falls back to a generic message for a non-Error rejection', () => {
    render(
      <CssVarsProvider theme={theme}>
        <AnalyticsErrorCard error="boom" onRetry={() => undefined} />
      </CssVarsProvider>
    );
    expect(screen.getByTestId('analytics-error')).toHaveTextContent('Could not load analytics: The request failed.');
  });
});
