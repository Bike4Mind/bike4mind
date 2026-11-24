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
    renderHistory();
    expect(screen.getByTestId('email-activity-start-date')).toHaveValue(String(mocks.lastParams?.startDate));
    expect(screen.getByTestId('email-activity-end-date')).toHaveValue(todayUtc());
    expect(mocks.lastParams).toMatchObject({ endDate: todayUtc() });
    expect(mocks.lastParams?.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
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
