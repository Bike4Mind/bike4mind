import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';

const mocks = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: mocks.post } }));
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }));
import FeedbackBulkActions from './FeedbackBulkActions';

const theme = extendTheme({ ...getThemeConfig() });
const ids = ['507f1f77bcf86cd799439011', '507f1f77bcf86cd799439012'];
const fingerprint = 'a'.repeat(64);
const onApplied = vi.fn().mockResolvedValue(undefined);
const onSelectionChange = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  mocks.post.mockImplementation(async (_url: string, body: { preview: boolean }) => ({
    data: { count: 2, fingerprint, applied: !body.preview },
  }));
});
function setup(allMatching = false) {
  return render(
    <CssVarsProvider theme={theme}>
      <FeedbackBulkActions
        selection={allMatching ? { mode: 'allMatching' } : { mode: 'explicit', ids }}
        filters={{ sort: 'desc', status: ['New'] }}
        total={7}
        disabled={false}
        onSelectionChange={onSelectionChange}
        onApplied={onApplied}
      />
    </CssVarsProvider>
  );
}
describe('feedback bulk dialog', () => {
  it('requires a close resolution, preview count, and reason before applying a page selection', async () => {
    setup();
    fireEvent.click(screen.getByTestId('feedback-bulk-status-btn'));
    expect(screen.getByTestId('feedback-bulk-preview-btn')).toBeDisabled();
    fireEvent.click(screen.getByTestId('feedback-bulk-resolution-select'));
    fireEvent.click(await screen.findByTestId('feedback-bulk-resolution-fixed'));
    fireEvent.click(screen.getByTestId('feedback-bulk-preview-btn'));
    await waitFor(() => expect(screen.getByTestId('feedback-bulk-preview-count')).toHaveTextContent('2 reports'));
    expect(screen.getByTestId('feedback-bulk-dialog-confirm-btn')).toBeDisabled();
    fireEvent.click(screen.getByTestId('feedback-bulk-dialog-reason-input-preset-0'));
    fireEvent.click(screen.getByTestId('feedback-bulk-dialog-confirm-btn'));
    await waitFor(() => expect(onApplied).toHaveBeenCalledOnce());
    expect(mocks.post).toHaveBeenLastCalledWith('/api/feedback/bulk', {
      selection: { mode: 'explicit', ids },
      change: { action: 'status', status: 'Closed', resolution: 'fixed' },
      preview: false,
      reason: 'Resolved after review',
      expectedCount: 2,
      fingerprint,
    });
    expect(onSelectionChange).toHaveBeenCalledWith({ mode: 'explicit', ids: [] });
  });
  it('sends filters for all-matching deletion and requires the preview count to be typed', async () => {
    setup(true);
    fireEvent.click(screen.getByTestId('feedback-bulk-delete-btn'));
    fireEvent.click(screen.getByTestId('feedback-bulk-preview-btn'));
    await screen.findByTestId('feedback-bulk-preview-count');
    fireEvent.click(screen.getByTestId('feedback-bulk-dialog-reason-input-preset-0'));
    expect(screen.getByTestId('feedback-bulk-dialog-confirm-btn')).toBeDisabled();
    fireEvent.change(screen.getByTestId('feedback-bulk-dialog-typed-input'), { target: { value: '2' } });
    fireEvent.click(screen.getByTestId('feedback-bulk-dialog-confirm-btn'));
    await waitFor(() => expect(onApplied).toHaveBeenCalledOnce());
    expect(mocks.post).toHaveBeenLastCalledWith(
      '/api/feedback/bulk',
      expect.objectContaining({
        selection: { mode: 'allMatching', filters: { sort: 'desc', status: ['New'] } },
        change: { action: 'delete' },
        expectedCount: 2,
        fingerprint,
      })
    );
  });
  it('invalidates the preview after a failed apply and shows the error', async () => {
    setup(true);
    fireEvent.click(screen.getByTestId('feedback-bulk-delete-btn'));
    fireEvent.click(screen.getByTestId('feedback-bulk-preview-btn'));
    await screen.findByTestId('feedback-bulk-preview-count');
    fireEvent.click(screen.getByTestId('feedback-bulk-dialog-reason-input-preset-0'));
    fireEvent.change(screen.getByTestId('feedback-bulk-dialog-typed-input'), { target: { value: '2' } });
    mocks.post.mockRejectedValueOnce(new Error('Selection changed'));
    fireEvent.click(screen.getByTestId('feedback-bulk-dialog-confirm-btn'));
    await waitFor(() => expect(screen.getByTestId('feedback-bulk-error')).toHaveTextContent('Selection changed'));
    expect(screen.getByTestId('feedback-bulk-dialog-confirm-btn')).toBeDisabled();
    expect(onApplied).not.toHaveBeenCalled();
  });
});
