import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { FeedbackStatus } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';

const mocks = vi.hoisted(() => ({ getFeedbackByIdFromServer: vi.fn() }));

vi.mock('@client/app/utils/feedbackAPICalls', () => ({
  getFeedbackByIdFromServer: mocks.getFeedbackByIdFromServer,
}));

import FocusedFeedbackCard from './FocusedFeedbackCard';

const appTheme = extendTheme({ ...getThemeConfig() });

const renderCard = (onDismiss = vi.fn()) => {
  // retry off, so a rejected fetch reaches the error branch on the first tick.
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={appTheme}>
        <FocusedFeedbackCard feedbackId="fb-1" onDismiss={onDismiss} />
      </CssVarsProvider>
    </QueryClientProvider>
  );
  return { onDismiss };
};

const record = (overrides: Record<string, unknown> = {}) => ({
  _id: 'fb-1',
  userId: 'user-1',
  content: 'The export button does nothing',
  status: FeedbackStatus.New,
  username: 'reporter',
  userEmail: 'reporter@example.com',
  organization: 'acme',
  createdAt: new Date('2024-01-01').toISOString(),
  ...overrides,
});

describe('FocusedFeedbackCard', () => {
  beforeEach(() => {
    mocks.getFeedbackByIdFromServer.mockReset();
  });

  it('fetches the linked record by id rather than reading the list on screen', async () => {
    mocks.getFeedbackByIdFromServer.mockResolvedValue(record());

    renderCard();

    await waitFor(() => expect(screen.getByTestId('feedback-focused-card')).toBeInTheDocument());
    expect(mocks.getFeedbackByIdFromServer).toHaveBeenCalledWith('fb-1');
    expect(await screen.findByText('The export button does nothing')).toBeInTheDocument();
    expect(screen.getByText('acme')).toBeInTheDocument();
    expect(screen.getByText('reporter')).toBeInTheDocument();
  });

  /**
   * The read route answers the same NotFoundError for a deleted record and for one belonging to
   * someone else, so the card must not render either as an empty success. Both a null body and a
   * rejected request have to land on the same visible notice.
   */
  it('shows the unavailable notice when the record resolves to null', async () => {
    mocks.getFeedbackByIdFromServer.mockResolvedValue(null);

    renderCard();

    expect(await screen.findByTestId('feedback-focused-missing')).toBeInTheDocument();
  });

  it('shows the unavailable notice when the request fails', async () => {
    mocks.getFeedbackByIdFromServer.mockRejectedValue(new Error('not found'));

    renderCard();

    expect(await screen.findByTestId('feedback-focused-missing')).toBeInTheDocument();
  });

  it('does not show the unavailable notice while the request is still in flight', () => {
    mocks.getFeedbackByIdFromServer.mockReturnValue(new Promise(() => {}));

    renderCard();

    expect(screen.getByTestId('feedback-focused-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('feedback-focused-missing')).not.toBeInTheDocument();
  });

  it('falls back to the expired-content marker instead of rendering a blank report', async () => {
    mocks.getFeedbackByIdFromServer.mockResolvedValue(record({ content: undefined, contentExpired: true }));

    renderCard();

    expect(await screen.findByText('[content expired]')).toBeInTheDocument();
  });

  it('hands the dismiss back to the caller so it can clear the deep-link param', async () => {
    mocks.getFeedbackByIdFromServer.mockResolvedValue(record());
    const { onDismiss } = renderCard();

    await userEvent.click(await screen.findByTestId('feedback-focused-dismiss-btn'));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
