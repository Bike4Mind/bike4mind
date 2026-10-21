import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { securityPaletteLight, securityPaletteDark } from '@client/app/theme/securityTheme';
import ApiKeyStatusTab from './ApiKeyStatusTab';

const h = vi.hoisted(() => ({
  keys: [] as Record<string, unknown>[],
}));

vi.mock('@client/app/hooks/data/admin', () => ({
  useGetApiUsage: () => ({ data: h.keys, isLoading: false }),
}));

// The tab reads theme.palette.security.* but getThemeConfig() does not carry
// those custom tokens, so the wrapper needs the security palette explicitly.
const testTheme = extendTheme({
  colorSchemes: {
    light: { palette: { ...securityPaletteLight } },
    dark: { palette: { ...securityPaletteDark } },
  },
});

const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={testTheme}>{children}</CssVarsProvider>
);

const nowSeconds = Math.floor(Date.now() / 1000);

const KEY = {
  id: 'k1',
  name: 'pipeline key',
  status: 'active',
  liveUsage: {
    minute: 3,
    day: 42,
    minuteResetAt: nowSeconds + 600,
    dayResetAt: nowSeconds + 6 * 3600,
  },
  rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
};

beforeEach(() => {
  h.keys = [];
});

describe('ApiKeyStatusTab', () => {
  it('renders minute and day counters with their reset times', () => {
    h.keys = [KEY];
    render(
      <Wrapper>
        <ApiKeyStatusTab />
      </Wrapper>
    );

    const minute = screen.getByTestId('api-key-usage-minute-0').textContent ?? '';
    expect(minute).toContain('3 / 60');
    expect(minute).toContain('resets in');

    const day = screen.getByTestId('api-key-usage-day-0').textContent ?? '';
    expect(day).toContain('42 / 1,000');
    expect(day).toContain('resets in');
  });

  it('hides the reset text while the minute window is empty', () => {
    h.keys = [{ ...KEY, liveUsage: { ...KEY.liveUsage, minute: 0, minuteResetAt: nowSeconds + 600 } }];
    render(
      <Wrapper>
        <ApiKeyStatusTab />
      </Wrapper>
    );

    const minute = screen.getByTestId('api-key-usage-minute-0').textContent ?? '';
    expect(minute).toContain('0 / 60');
    expect(minute).not.toContain('resets in');
  });
});
