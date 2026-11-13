import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { FeedbackStatus } from '@bike4mind/common';
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api }));
vi.mock('../shared/MissingPermission', () => ({
  AdminPermissionAction: ({ children }: { children: (disabled: boolean) => React.ReactNode }) => children(false),
}));
import FeedbackSimilarReports from './FeedbackSimilarReports';
const theme = extendTheme({ ...getThemeConfig() });
const original = '507f1f77bcf86cd799439011';
const open = '507f1f77bcf86cd799439012';
const closed = '507f1f77bcf86cd799439013';
const renderSection = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CssVarsProvider theme={theme}>
        <FeedbackSimilarReports feedbackId={original} />
      </CssVarsProvider>
    </QueryClientProvider>
  );
beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue({
    data: {
      limited: false,
      items: [
        {
          id: open,
          status: FeedbackStatus.New,
          excerpt: 'The stream stops after attaching a file',
          createdAt: '2026-11-13',
          similarity: 1,
        },
        {
          id: closed,
          status: FeedbackStatus.Closed,
          excerpt: 'A closed matching report',
          createdAt: '2026-11-13',
          similarity: 1,
        },
      ],
    },
  });
  api.post.mockResolvedValue({ data: { count: 1, fingerprint: 'snapshot', applied: false } });
});
describe('FeedbackSimilarReports', () => {
  it('shows deterministic matches with links and previews only open reports before audited apply', async () => {
    renderSection();
    expect(await screen.findByTestId(`feedback-similar-link-${open}`)).toHaveTextContent('stream stops');
    expect(screen.getByTestId(`feedback-similar-link-${open}`)).toHaveAttribute(
      'href',
      `/admin?tab=feedback&feedbackId=${open}`
    );
    await userEvent.click(screen.getByTestId('feedback-similar-close-btn'));
    const selection = { mode: 'explicit', ids: [open] };
    const change = { action: 'status', status: 'Closed', resolution: 'duplicate', resolutionDuplicateId: original };
    expect(api.post).toHaveBeenCalledWith('/api/feedback/bulk', { selection, change, preview: true });
    expect(await screen.findByTestId('feedback-similar-close-dialog')).toHaveTextContent('Each closure is audited');
    await userEvent.click(screen.getByTestId('feedback-similar-close-dialog-reason-input-preset-0'));
    await userEvent.click(screen.getByTestId('feedback-similar-close-dialog-confirm-btn'));
    await waitFor(() =>
      expect(api.post).toHaveBeenLastCalledWith('/api/feedback/bulk', {
        selection,
        change,
        preview: false,
        expectedCount: 1,
        fingerprint: 'snapshot',
        reason: 'Same issue reported more than once',
      })
    );
  });
  it('keeps failed apply visible and requires a new preview for changed reports', async () => {
    renderSection();
    await userEvent.click(await screen.findByTestId('feedback-similar-close-btn'));
    await screen.findByTestId('feedback-similar-close-dialog');
    api.post.mockRejectedValueOnce(new Error('cohort changed'));
    await userEvent.click(screen.getByTestId('feedback-similar-close-dialog-reason-input-preset-0'));
    await userEvent.click(screen.getByTestId('feedback-similar-close-dialog-confirm-btn'));
    expect(await screen.findByText(/Cancel and preview again/)).toBeInTheDocument();
    expect(screen.getByTestId('feedback-similar-close-dialog')).toBeInTheDocument();
  });
  it('shows scan limitations and empty/error states without an action on no matches', async () => {
    api.get.mockResolvedValue({ data: { items: [], limited: true } });
    renderSection();
    expect(await screen.findByText('No similar reports found')).toBeInTheDocument();
    expect(screen.getByText(/newest 500 reports/)).toBeInTheDocument();
    expect(screen.queryByTestId('feedback-similar-close-btn')).not.toBeInTheDocument();
  });
  it('shows a retry state when lookup fails', async () => {
    api.get.mockRejectedValueOnce(new Error('offline'));
    renderSection();
    expect(await screen.findByText('Could not load similar reports.')).toBeInTheDocument();
    expect(screen.queryByTestId('feedback-similar-close-btn')).not.toBeInTheDocument();
  });
});
