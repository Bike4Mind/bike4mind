import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import dayjs from 'dayjs';
import { describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import { ControlPanel } from './ControlPanel';

const appTheme = extendTheme({ ...getThemeConfig() });

const renderPanel = (overrides: { dateFrom?: string; dateTo?: string } = {}) => {
  const setDateFrom = vi.fn();
  const setDateTo = vi.fn();
  render(
    <CssVarsProvider theme={appTheme}>
      <ControlPanel
        metrics={[]}
        dateRange="custom"
        dateFrom={overrides.dateFrom ?? ''}
        dateTo={overrides.dateTo ?? ''}
        userFilter=""
        eventFilter=""
        eventCategoryFilter=""
        setDateFrom={setDateFrom}
        setDateTo={setDateTo}
        setUserFilter={vi.fn()}
        setEventFilter={vi.fn()}
        setEventCategoryFilter={vi.fn()}
        onClearFilters={vi.fn()}
        onSetDateRange={vi.fn()}
        hasFilters={false}
      />
    </CssVarsProvider>
  );
  return { setDateFrom, setDateTo };
};

describe('ControlPanel custom range', () => {
  it('shows empty labels and emits nothing while both bounds are unset', () => {
    const { setDateFrom, setDateTo } = renderPanel();
    expect(screen.getByTestId('event-metrics-date-from-empty')).toHaveTextContent('From any date');
    expect(screen.getByTestId('event-metrics-date-to-empty')).toHaveTextContent('To any date');
    expect(setDateFrom).not.toHaveBeenCalled();
    expect(setDateTo).not.toHaveBeenCalled();
  });

  it('emits the start and end of the local day when a bound is set', () => {
    const { setDateFrom, setDateTo } = renderPanel();
    fireEvent.click(screen.getByTestId('event-metrics-date-from-set-btn'));
    expect(setDateFrom).toHaveBeenCalledWith(dayjs().startOf('day').toISOString());
    fireEvent.click(screen.getByTestId('event-metrics-date-to-set-btn'));
    expect(setDateTo).toHaveBeenCalledWith(dayjs().endOf('day').toISOString());
  });

  it('emits an empty bound when a set date is cleared', () => {
    const { setDateFrom } = renderPanel({ dateFrom: dayjs('2026-03-04').startOf('day').toISOString() });
    expect(screen.getByTestId('event-metrics-date-from')).toHaveValue('2026-03-04');
    fireEvent.click(screen.getByTestId('event-metrics-date-from-clear-btn'));
    expect(setDateFrom).toHaveBeenCalledWith('');
  });
});
