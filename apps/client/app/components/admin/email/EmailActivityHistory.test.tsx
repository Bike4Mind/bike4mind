import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import { todayUtc } from '@client/app/utils/dateUtils';

const mocks = vi.hoisted(() => ({ lastParams: undefined as Record<string, unknown> | undefined }));

vi.mock('@client/app/hooks/data/emailMarketing', () => ({
  useEmailJobHistory: (_jobId: string | undefined, params: Record<string, unknown>) => {
    mocks.lastParams = params;
    return {
      data: { data: [], meta: { currentPage: 1, totalPages: 0, total: 0 } },
      isLoading: false,
      refetch: vi.fn(),
    };
  },
}));

import EmailActivityHistory from './EmailActivityHistory';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderHistory = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <EmailActivityHistory onViewAttempt={vi.fn()} />
    </CssVarsProvider>
  );

describe('EmailActivityHistory date bounds', () => {
  beforeEach(() => {
    mocks.lastParams = undefined;
  });

  it('starts with the last 30 days set and sends both bounds', () => {
    // Midday UTC keeps the local day equal to the UTC day in every zone the suite runs in.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-15T12:00:00Z'));
    try {
      renderHistory();
      expect(screen.getByTestId('email-activity-start-date')).toHaveValue('2026-05-16');
      expect(screen.getByTestId('email-activity-end-date')).toHaveValue('2026-06-15');
      expect(mocks.lastParams).toMatchObject({ startDate: '2026-05-16', endDate: '2026-06-15' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the empty label and omits a bound once it is cleared, then sends it again when set', () => {
    renderHistory();
    fireEvent.click(screen.getByTestId('email-activity-start-date-clear-btn'));
    expect(screen.getByTestId('email-activity-start-date-empty')).toHaveTextContent('From any date');
    expect(mocks.lastParams?.startDate).toBe('');

    fireEvent.click(screen.getByTestId('email-activity-start-date-set-btn'));
    expect(mocks.lastParams?.startDate).toBe(todayUtc());
  });
});
