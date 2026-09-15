import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { securityPaletteLight, securityPaletteDark } from '@client/app/theme/securityTheme';
import SecurityMetricCard from '../SecurityMetricCard';

// Use a theme that includes the custom security palette tokens so
// theme.palette.security.* resolves correctly during tests.
const testTheme = extendTheme({
  colorSchemes: {
    light: { palette: { ...securityPaletteLight } },
    dark: { palette: { ...securityPaletteDark } },
  },
});

const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={testTheme}>{children}</CssVarsProvider>
);

describe('SecurityMetricCard', () => {
  it('renders label and value', () => {
    render(
      <Wrapper>
        <SecurityMetricCard icon={<span />} label="Failed Logins" value={3} status="high" data-testid="test-card" />
      </Wrapper>
    );
    expect(screen.getByTestId('test-card')).toBeTruthy();
    expect(screen.getByTestId('test-card-value').textContent).toBe('3');
    expect(screen.getByText('Failed Logins')).toBeTruthy();
  });

  it('shows — when isLoading', () => {
    render(
      <Wrapper>
        <SecurityMetricCard icon={<span />} label="Test" value={5} status="good" isLoading data-testid="loading-card" />
      </Wrapper>
    );
    expect(screen.getByTestId('loading-card-value').textContent).toBe('—');
  });

  it('calls onTabSelect when clicked', () => {
    const onTabSelect = vi.fn();
    render(
      <Wrapper>
        <SecurityMetricCard
          icon={<span />}
          label="Test"
          value={0}
          status="good"
          onTabSelect={onTabSelect}
          data-testid="click-card"
        />
      </Wrapper>
    );
    fireEvent.click(screen.getByTestId('click-card'));
    expect(onTabSelect).toHaveBeenCalledOnce();
  });

  it('renders description when provided', () => {
    render(
      <Wrapper>
        <SecurityMetricCard icon={<span />} label="Test" value={0} status="good" description="Last 24 hours" />
      </Wrapper>
    );
    expect(screen.getByText('Last 24 hours')).toBeTruthy();
  });
});
