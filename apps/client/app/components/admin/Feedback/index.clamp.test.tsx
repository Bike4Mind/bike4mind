import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { FeedbackStatus, FeedbackType } from '@bike4mind/common';
import type { PromptMeta } from '@bike4mind/common';
import type { IExtendedFeedbackDocument } from './types';

const mocks = vi.hoisted(() => ({
  getFeedbackFromServer: vi.fn(),
  deleteFeedbackFromServer: vi.fn(),
}));

vi.mock('@client/app/hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('@client/app/utils/feedbackAPICalls', () => ({
  getFeedbackFromServer: mocks.getFeedbackFromServer,
  deleteFeedbackFromServer: mocks.deleteFeedbackFromServer,
  updateFeedbackOnServer: vi.fn(),
  getAllFeedbackForExport: vi.fn(),
  FEEDBACK_EXPORT_MAX_ROWS: 5000,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('@tanstack/react-router', async () => (await import('../__tests__/fakeAdminRouter')).fakeRouterModule);

import { fakeAdminRouter } from '../__tests__/fakeAdminRouter';
import FeedbackTab from './index';

const appTheme = extendTheme({ ...getThemeConfig() });

const makeFeedbackItem = (): IExtendedFeedbackDocument => ({
  id: 'fb-1',
  _id: 'fb-1',
  userId: 'user-1',
  status: FeedbackStatus.New,
  username: 'reporter',
  userEmail: 'reporter@example.com',
  customerService: '',
  organization: 'acme',
  type: FeedbackType.FEEDBACK,
  promptMeta: {} as unknown as PromptMeta,
  subject: 'product',
  contentStored: true,
  content: 'Some feedback content',
  createdAt: new Date('2024-01-01T00:00:00.000Z'),
  updatedAt: new Date('2024-01-01T00:00:00.000Z'),
});

const renderFeedbackTab = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={appTheme}>
        <FeedbackTab />
      </CssVarsProvider>
    </QueryClientProvider>
  );
};

// Runs the real useFeedbackOperations/useFeedbackPagination chain; only the HTTP layer is mocked.
describe('FeedbackTab page clamp after the last page empties', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    act(() => fakeAdminRouter.reset({ tab: 'feedback', feedbackPage: 3 }));
  });

  it('waits out the same-key refetch, then clamps once to the new last page', async () => {
    let resolveRefetch: (value: unknown) => void = () => undefined;
    let listCalls = 0;
    mocks.getFeedbackFromServer.mockImplementation((params: { includeOrganizations?: boolean }) => {
      if (params.includeOrganizations) return Promise.resolve({ items: [], total: 0, organizations: [] });
      listCalls += 1;
      if (listCalls === 1) return Promise.resolve({ items: [makeFeedbackItem()], total: 41 });
      return new Promise(resolve => (resolveRefetch = resolve));
    });
    mocks.deleteFeedbackFromServer.mockResolvedValue(true);

    renderFeedbackTab();
    await userEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await userEvent.click(await screen.findByTestId('confirm-modal-confirm-btn'));

    await waitFor(() => expect(listCalls).toBe(2));
    expect(fakeAdminRouter.search).toMatchObject({ feedbackPage: 3 });
    expect(fakeAdminRouter.navigate).not.toHaveBeenCalled();

    await act(async () => resolveRefetch({ items: [], total: 40 }));

    await waitFor(() => expect(fakeAdminRouter.search).toMatchObject({ feedbackPage: 2 }));
    expect(fakeAdminRouter.navigate).toHaveBeenCalledTimes(1);
    expect(fakeAdminRouter.navigate).toHaveBeenCalledWith(expect.objectContaining({ replace: true }));
  });
});
