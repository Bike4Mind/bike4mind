import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import dayjs from 'dayjs';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { FeedbackCreatedRangeDialog, type CreatedRange } from './FeedbackCreatedRangeDialog';

const theme = extendTheme({ ...getThemeConfig() });
const renderDialog = (initial: CreatedRange) => {
  const onApply = vi.fn();
  render(
    <CssVarsProvider theme={theme}>
      <FeedbackCreatedRangeDialog initial={initial} onApply={onApply} onClose={vi.fn()} />
    </CssVarsProvider>
  );
  return onApply;
};

describe('FeedbackCreatedRangeDialog', () => {
  it('shows empty labels for an open end and applies only the end that is set', () => {
    const onApply = renderDialog({ createdFrom: undefined, createdTo: '2026-10-07' });
    expect(screen.getByTestId('feedback-created-range-from-input-empty')).toHaveTextContent('Any start');
    expect(screen.queryByTestId('feedback-created-range-from-input')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('feedback-created-range-apply-btn'));
    expect(onApply).toHaveBeenCalledWith({ createdFrom: undefined, createdTo: '2026-10-07' });
  });

  it('prefills the last seven days when nothing is set', () => {
    renderDialog({ createdFrom: undefined, createdTo: undefined });
    expect(screen.getByTestId('feedback-created-range-to-input')).toHaveValue(dayjs().format('YYYY-MM-DD'));
    expect(screen.getByTestId('feedback-created-range-from-input')).toHaveValue(
      dayjs().subtract(6, 'day').format('YYYY-MM-DD')
    );
  });

  it('keeps an added start day on or before the end day and drops it again when removed', () => {
    const onApply = renderDialog({ createdFrom: undefined, createdTo: '2020-05-05' });
    fireEvent.click(screen.getByTestId('feedback-created-range-from-input-set-btn'));
    expect(screen.getByTestId('feedback-created-range-from-input')).toHaveValue('2020-05-05');
    fireEvent.click(screen.getByTestId('feedback-created-range-from-input-clear-btn'));
    expect(screen.getByTestId('feedback-created-range-from-input-empty')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('feedback-created-range-apply-btn'));
    expect(onApply).toHaveBeenCalledWith({ createdFrom: undefined, createdTo: '2020-05-05' });
  });

  it('shows the inverted message and blocks Apply when the end precedes the start', () => {
    renderDialog({ createdFrom: '2026-10-07', createdTo: '2026-10-01' });
    expect(screen.getByText('Ends before it starts.')).toBeInTheDocument();
    expect(screen.getByTestId('feedback-created-range-apply-btn')).toBeDisabled();
    expect(screen.getByTestId('feedback-created-range-to-input-root')).toHaveClass('MuiInput-colorDanger');
    expect(screen.getByTestId('feedback-created-range-from-input-root')).not.toHaveClass('MuiInput-colorDanger');
  });
});
