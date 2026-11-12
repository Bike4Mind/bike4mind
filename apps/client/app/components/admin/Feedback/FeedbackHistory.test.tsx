import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
const mocks = vi.hoisted(() => ({ get: vi.fn(), add: vi.fn() }));
vi.mock('@client/app/utils/feedbackAPICalls', () => ({
  getFeedbackHistoryFromServer: mocks.get,
  addFeedbackNoteOnServer: mocks.add,
}));
import FeedbackHistory from './FeedbackHistory';
const theme = extendTheme({ ...getThemeConfig() });
const renderHistory = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CssVarsProvider theme={theme}>
        <FeedbackHistory id="report1" />
      </CssVarsProvider>
    </QueryClientProvider>
  );
beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue({
    items: [
      {
        id: 'entry1',
        occurredAt: '2026-01-01T00:00:00Z',
        author: 'Admin',
        summary: 'added note',
        note: 'Investigating the issue',
      },
    ],
    nextCursor: null,
  });
  mocks.add.mockResolvedValue(undefined);
});
describe('private feedback history UI', () => {
  it('renders the author and note, saves a private note and refreshes history', async () => {
    renderHistory();
    expect(await screen.findByTestId('feedback-history-entry-entry1')).toHaveTextContent('Admin');
    expect(screen.getByTestId('feedback-history-entry-entry1')).toHaveTextContent('Investigating the issue');
    await userEvent.type(screen.getByTestId('feedback-note-input'), 'New reproduction');
    await userEvent.click(screen.getByTestId('feedback-note-add-btn'));
    await waitFor(() => expect(mocks.add).toHaveBeenCalledWith('report1', 'New reproduction'));
    await waitFor(() => expect(screen.getByTestId('feedback-note-input')).toHaveValue(''));
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });
  it('retains a failed note for retry and shows the error', async () => {
    mocks.add.mockRejectedValue(new Error('Could not save'));
    renderHistory();
    await userEvent.type(screen.getByTestId('feedback-note-input'), 'Keep this draft');
    await userEvent.click(screen.getByTestId('feedback-note-add-btn'));
    expect(await screen.findByTestId('feedback-note-error')).toHaveTextContent('Could not save');
    expect(screen.getByTestId('feedback-note-input')).toHaveValue('Keep this draft');
  });
});
