import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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
        <FeedbackCloseDialog feedbackId="507f1f77bcf86cd7994390fb" onClose={vi.fn()} onConfirm={confirm} />
      </CssVarsProvider>
    );
    await userEvent.type(screen.getByTestId('feedback-close-dialog-reason-input'), 'Same reproduction');
    expect(screen.getByTestId('feedback-close-dialog-confirm-btn')).toBeDisabled();
    fireEvent.click(screen.getByTestId('feedback-close-dialog-confirm-btn'));
    expect(confirm).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('feedback-close-resolution-select'));
    await userEvent.click(screen.getByRole('option', { name: 'Duplicate' }));
    expect(screen.getByTestId('feedback-close-dialog-confirm-btn')).toBeDisabled();
    const duplicateInput = screen.getByTestId('feedback-close-duplicate-input');
    for (const invalidId of ['', 'a'.repeat(23), 'z'.repeat(24), '507F1F77BCF86CD7994390FB']) {
      await userEvent.clear(duplicateInput);
      if (invalidId) await userEvent.type(duplicateInput, invalidId);
      expect(screen.getByTestId('feedback-close-dialog-confirm-btn')).toBeDisabled();
      fireEvent.click(screen.getByTestId('feedback-close-dialog-confirm-btn'));
      expect(confirm).not.toHaveBeenCalled();
    }
    await userEvent.clear(duplicateInput);
    await userEvent.type(duplicateInput, '507f1f77bcf86cd799439000');
    expect(screen.getByTestId('feedback-close-dialog-confirm-btn')).toBeEnabled();
    await userEvent.click(screen.getByTestId('feedback-close-dialog-confirm-btn'));
    expect(confirm).toHaveBeenCalledWith({
      resolution: 'duplicate',
      resolutionDuplicateId: '507f1f77bcf86cd799439000',
      reason: 'Same reproduction',
    });
  });
});
