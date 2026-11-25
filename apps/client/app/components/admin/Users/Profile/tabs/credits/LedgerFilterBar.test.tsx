import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { todayUtc } from '@client/app/utils/dateUtils';
import { LedgerFilterBar } from './LedgerFilterBar';
import { EMPTY_LEDGER_FILTER, type LedgerFilterState } from './creditLedgerModel';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderBar = (value: LedgerFilterState, onChange = vi.fn()) => {
  render(
    <CssVarsProvider theme={appTheme}>
      <LedgerFilterBar value={value} onChange={onChange} modelOptions={[]} />
    </CssVarsProvider>
  );
  return onChange;
};

describe('LedgerFilterBar date range', () => {
  it('shows empty labels instead of native date inputs while unset', () => {
    const onChange = renderBar(EMPTY_LEDGER_FILTER);
    expect(screen.getByTestId('user-credits-from-empty')).toHaveTextContent('From any day');
    expect(screen.getByTestId('user-credits-to-empty')).toHaveTextContent('To any day');
    expect(screen.queryByTestId('user-credits-from')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('sets today (UTC) as the start day when the start date is added', () => {
    const onChange = renderBar(EMPTY_LEDGER_FILTER);
    fireEvent.click(screen.getByTestId('user-credits-from-set-btn'));
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_LEDGER_FILTER, from: todayUtc() });
  });

  it('keeps the added start day inside an end day in the past', () => {
    const onChange = renderBar({ ...EMPTY_LEDGER_FILTER, to: '2020-05-05' });
    fireEvent.click(screen.getByTestId('user-credits-from-set-btn'));
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_LEDGER_FILTER, to: '2020-05-05', from: '2020-05-05' });
  });

  it('emits an edited day and clears back to the empty string', () => {
    const onChange = renderBar({ ...EMPTY_LEDGER_FILTER, from: '2026-10-01' });
    fireEvent.change(screen.getByTestId('user-credits-from'), { target: { value: '2026-10-02' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_LEDGER_FILTER, from: '2026-10-02' });
    fireEvent.click(screen.getByTestId('user-credits-from-clear-btn'));
    expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_LEDGER_FILTER, from: '' });
  });

  it('outlines both days as errored only while the range is inverted', () => {
    const errored = (testId: string) => screen.getByTestId(testId).closest('.MuiInput-root');
    renderBar({ ...EMPTY_LEDGER_FILTER, from: '2026-10-05', to: '2026-10-01' });
    expect(errored('user-credits-from')).toHaveClass('Mui-error');
    expect(errored('user-credits-to')).toHaveClass('Mui-error');
    expect(screen.getByText('The start date is after the end date.')).toBeInTheDocument();
  });

  it('does not outline a range in order', () => {
    renderBar({ ...EMPTY_LEDGER_FILTER, from: '2026-10-01', to: '2026-10-05' });
    expect(screen.getByTestId('user-credits-from').closest('.MuiInput-root')).not.toHaveClass('Mui-error');
    expect(screen.getByTestId('user-credits-to').closest('.MuiInput-root')).not.toHaveClass('Mui-error');
  });
});
