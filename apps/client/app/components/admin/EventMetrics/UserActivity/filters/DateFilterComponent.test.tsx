import React, { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import dayjs from 'dayjs';
import { getThemeConfig } from '@client/app/utils/themes';
import { DateFilterComponent } from './DateFilterComponent';
import { useAnalyticsStore } from '../store';
import type { DateRange } from '../dateRange';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const daysAgo = (days: number) => dayjs().subtract(days, 'day').format('YYYY-MM-DD');

const ControlledDateFilter = ({ initial, onChange }: { initial: DateRange; onChange?: (range: DateRange) => void }) => {
  const [value, setValue] = useState(initial);
  return (
    <DateFilterComponent
      value={value}
      onChange={range => {
        setValue(range);
        onChange?.(range);
      }}
    />
  );
};

const renderFilter = (initial: DateRange, onChange?: (range: DateRange) => void) =>
  render(
    <TestWrapper>
      <ControlledDateFilter initial={initial} onChange={onChange} />
    </TestWrapper>
  );

const isPressed = (testId: string) => screen.getByTestId(testId).getAttribute('aria-pressed') === 'true';

describe('DateFilterComponent', () => {
  it('selects exactly 7 days ending today and keeps the preset highlighted', () => {
    const onChange = vi.fn();
    renderFilter({ startDate: daysAgo(40), endDate: daysAgo(20) }, onChange);

    fireEvent.click(screen.getByTestId('date-filter-preset-7-btn'));

    expect(onChange).toHaveBeenCalledWith({ startDate: daysAgo(6), endDate: daysAgo(0) });
    expect(screen.getByTestId('date-filter-start-input')).toHaveValue(daysAgo(6));
    expect(screen.getByTestId('date-filter-end-input')).toHaveValue(daysAgo(0));
    expect(isPressed('date-filter-preset-7-btn')).toBe(true);
    expect(isPressed('date-filter-preset-30-btn')).toBe(false);
  });

  it('selects exactly 30 days ending today', () => {
    const onChange = vi.fn();
    renderFilter({ startDate: daysAgo(6), endDate: daysAgo(0) }, onChange);

    fireEvent.click(screen.getByTestId('date-filter-preset-30-btn'));

    expect(onChange).toHaveBeenCalledWith({ startDate: daysAgo(29), endDate: daysAgo(0) });
    expect(isPressed('date-filter-preset-30-btn')).toBe(true);
  });

  it('drops the preset highlight once the start date is edited by hand', () => {
    renderFilter({ startDate: daysAgo(6), endDate: daysAgo(0) });
    expect(isPressed('date-filter-preset-7-btn')).toBe(true);

    fireEvent.change(screen.getByTestId('date-filter-start-input'), { target: { value: daysAgo(9) } });

    expect(isPressed('date-filter-preset-7-btn')).toBe(false);
  });

  it('leaves the shared analytics store alone; the owner decides where the range lives', () => {
    const before = useAnalyticsStore.getState().dateFilters;
    renderFilter({ startDate: daysAgo(6), endDate: daysAgo(0) });

    fireEvent.click(screen.getByTestId('date-filter-preset-30-btn'));

    expect(useAnalyticsStore.getState().dateFilters).toBe(before);
  });

  it('does not emit a cleared date, so no request goes out with an empty bound', () => {
    const onChange = vi.fn();
    renderFilter({ startDate: daysAgo(6), endDate: daysAgo(0) }, onChange);

    fireEvent.change(screen.getByTestId('date-filter-start-input'), { target: { value: '' } });
    fireEvent.change(screen.getByTestId('date-filter-end-input'), { target: { value: '' } });

    expect(onChange).not.toHaveBeenCalled();
  });
});
