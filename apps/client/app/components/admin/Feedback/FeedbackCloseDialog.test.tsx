import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import FeedbackCloseDialog from './FeedbackCloseDialog';
const theme = extendTheme({ ...getThemeConfig() });
describe('close feedback', () => {
  it('cannot submit without a resolution and requires an original id for duplicates', async () => {
    const confirm = vi.fn();
    render(
      <CssVarsProvider theme={theme}>
        <FeedbackCloseDialog onClose={vi.fn()} onConfirm={confirm} />
      </CssVarsProvider>
    );
    expect(screen.getByTestId('feedback-close-dialog-confirm-btn')).toBeDisabled();
    await userEvent.click(screen.getByTestId('feedback-close-resolution-select'));
    await userEvent.click(screen.getByRole('option', { name: 'Duplicate' }));
    expect(screen.getByTestId('feedback-close-dialog-confirm-btn')).toBeDisabled();
    await userEvent.type(screen.getByTestId('feedback-close-duplicate-input'), '507f1f77bcf86cd799439000');
    await userEvent.type(screen.getByTestId('feedback-close-dialog-reason-input'), 'Same reproduction');
    await userEvent.click(screen.getByTestId('feedback-close-dialog-confirm-btn'));
    expect(confirm).toHaveBeenCalledWith({
      resolution: 'duplicate',
      resolutionDuplicateId: '507f1f77bcf86cd799439000',
      reason: 'Same reproduction',
    });
  });
});
