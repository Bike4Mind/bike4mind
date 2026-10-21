import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

// Pinned clock: the minute window formats in minutes, the day window in hours, so each
// assertion names the window that produced it.
const NOW_MS = new Date('2026-10-21T12:00:00Z').getTime();
const NOW_S = Math.floor(NOW_MS / 1000);

// Day limit stays below 1000 so no grouping separator applies under a non-en locale.
const KEY = {
  id: 'k1',
  name: 'pipeline key',
  status: 'active',
  liveUsage: {
    minute: 3,
    day: 42,
    minuteResetAt: NOW_S + 600,
    dayResetAt: NOW_S + 6 * 3600 + 12 * 60,
  },
  rateLimit: { requestsPerMinute: 60, requestsPerDay: 800 },
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
  h.keys = [];
});

afterEach(() => {
  vi.useRealTimers();
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
    expect(minute).toContain('resets in 10m');

    const day = screen.getByTestId('api-key-usage-day-0').textContent ?? '';
    expect(day).toContain('42 / 800');
    expect(day).toContain('resets in 6h 12m');
  });

  it('hides the reset text while a window is empty', () => {
    h.keys = [{ ...KEY, liveUsage: { ...KEY.liveUsage, minute: 0, day: 0 } }];
    render(
      <Wrapper>
        <ApiKeyStatusTab />
      </Wrapper>
    );

    const minute = screen.getByTestId('api-key-usage-minute-0').textContent ?? '';
    expect(minute).toContain('0 / 60');
    expect(minute).not.toContain('resets in');

    const day = screen.getByTestId('api-key-usage-day-0').textContent ?? '';
    expect(day).toContain('0 / 800');
    expect(day).not.toContain('resets in');
  });
});
