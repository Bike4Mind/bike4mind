import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { FeedbackStatus, FeedbackType } from '@bike4mind/common';
import type { PromptMeta } from '@bike4mind/common';
import type {
  IExtendedFeedbackDocument,
  UseFeedbackOperationsReturn,
  UseFeedbackFiltersReturn,
  UseFeedbackPaginationReturn,
} from './types';

const mocks = vi.hoisted(() => ({
  useIsMobile: vi.fn(),
  useFeedbackOperations: vi.fn(),
  useFeedbackFilters: vi.fn(),
  useFeedbackPagination: vi.fn(),
  getAllFeedbackForExport: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastWarning: vi.fn(),
  useNavigate: vi.fn(),
  useSearch: vi.fn(),
  papaUnparse: vi.fn(),
}));

vi.mock('@client/app/hooks/useIsMobile', () => ({ useIsMobile: mocks.useIsMobile }));
vi.mock('./hooks/useFeedbackOperations', () => ({ useFeedbackOperations: mocks.useFeedbackOperations }));
vi.mock('./hooks/useFeedbackFilters', () => ({ useFeedbackFilters: mocks.useFeedbackFilters }));
vi.mock('./hooks/useFeedbackPagination', () => ({ useFeedbackPagination: mocks.useFeedbackPagination }));
vi.mock('@client/app/utils/feedbackAPICalls', () => ({
  getAllFeedbackForExport: mocks.getAllFeedbackForExport,
  FEEDBACK_EXPORT_MAX_ROWS: 5000,
}));
vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError, warning: mocks.toastWarning },
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: mocks.useNavigate,
  useSearch: mocks.useSearch,
}));
vi.mock('papaparse', () => ({ default: { unparse: mocks.papaUnparse } }));

import FeedbackTab from './index';

const appTheme = extendTheme({ ...getThemeConfig() });

const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const renderFeedbackTab = () => render(<FeedbackTab />, { wrapper: TestWrapper });

const makeFeedbackItem = (overrides: Partial<IExtendedFeedbackDocument> = {}): IExtendedFeedbackDocument => ({
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
  ...overrides,
});

const helpFeedbackItem = makeFeedbackItem({
  _id: 'fb-help-1',
  id: 'fb-help-1',
  subject: 'help',
  helpContext: { eventId: 'evt-1', surface: 'article', slug: 'features/export', reportType: 'outdated' },
});

const defaultFiltersReturn: UseFeedbackFiltersReturn = {
  filters: {
    searchTerm: '',
    statusFilters: {
      [FeedbackStatus.New]: true,
      [FeedbackStatus.InProgress]: false,
      [FeedbackStatus.Closed]: false,
    },
    selectedOrganizations: [],
    sortAscending: false,
  },
  setSearchTerm: vi.fn(),
  setStatusFilters: vi.fn(),
  setSelectedOrganizations: vi.fn(),
  setSubject: vi.fn(),
  toggleSortDirection: vi.fn(),
  filterParams: { sort: 'desc' },
};

const defaultPaginationReturn: UseFeedbackPaginationReturn = {
  currentPage: 1,
  handlePageChange: vi.fn(),
  itemsPerPage: 20,
  handleItemsPerPageChange: vi.fn(),
  resetPage: vi.fn(),
};

const makeOperationsReturn = (
  feedback: IExtendedFeedbackDocument[],
  overrides: Partial<UseFeedbackOperationsReturn> = {}
): UseFeedbackOperationsReturn => ({
  feedback,
  organizations: [],
  total: feedback.length,
  loading: false,
  refreshFeedback: vi.fn(),
  handleStatusChange: vi.fn(),
  handleDeleteFeedbackClick: vi.fn(),
  confirmDeleteFeedback: vi.fn(),
  feedbackToDelete: null,
  openDeleteFeedbackModal: false,
  toggleDeleteFeedbackModal: vi.fn(),
  ...overrides,
});

describe('FeedbackTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useFeedbackFilters.mockReturnValue(defaultFiltersReturn);
    mocks.useFeedbackPagination.mockReturnValue(defaultPaginationReturn);
    mocks.useNavigate.mockReturnValue(vi.fn());
    mocks.useSearch.mockReturnValue({});
    mocks.papaUnparse.mockReturnValue('id\n');
    globalThis.URL.createObjectURL = vi.fn().mockReturnValue('blob:test');
    globalThis.URL.revokeObjectURL = vi.fn();
  });

  it('mounts the help context chip in the mobile card layout', () => {
    mocks.useIsMobile.mockReturnValue(true);
    mocks.useFeedbackOperations.mockReturnValue(makeOperationsReturn([helpFeedbackItem]));

    renderFeedbackTab();

    expect(screen.getByTestId('feedback-help-context-chip')).toHaveTextContent('features/export');
    expect(screen.getByTestId('feedback-help-outdated-chip')).toBeInTheDocument();
  });

  it('mounts the help context chip in the desktop grid layout', () => {
    mocks.useIsMobile.mockReturnValue(false);
    mocks.useFeedbackOperations.mockReturnValue(makeOperationsReturn([helpFeedbackItem]));

    renderFeedbackTab();

    expect(screen.getByTestId('feedback-help-context-chip')).toHaveTextContent('features/export');
    expect(screen.getByTestId('feedback-help-outdated-chip')).toBeInTheDocument();
  });

  it('exports the help article slug as the HelpArticle CSV column', async () => {
    mocks.useIsMobile.mockReturnValue(false);
    mocks.useFeedbackOperations.mockReturnValue(makeOperationsReturn([helpFeedbackItem]));
    mocks.getAllFeedbackForExport.mockResolvedValue({ items: [helpFeedbackItem], truncated: false });

    renderFeedbackTab();

    await userEvent.click(screen.getByRole('button', { name: 'Export CSV' }));

    await waitFor(() => expect(mocks.papaUnparse).toHaveBeenCalledTimes(1));

    const [csvRows] = mocks.papaUnparse.mock.calls[0] as [Array<Record<string, unknown>>];
    expect(csvRows[0]).toMatchObject({ HelpArticle: 'features/export' });
  });

  // The hook and the sentinel mapping are unit-tested on their own; what only a mounted render can
  // show is that the Select is actually wired to the setter, and that its options carry the subject
  // values rather than the labels an operator reads.
  describe('subject filter', () => {
    beforeEach(() => {
      mocks.useIsMobile.mockReturnValue(false);
      mocks.useFeedbackOperations.mockReturnValue(makeOperationsReturn([makeFeedbackItem()]));
    });

    it('offers every subject the server accepts, plus a way back to all of them', async () => {
      renderFeedbackTab();

      await userEvent.click(screen.getByTestId('feedback-subject-filter-select'));

      const options = screen.getAllByRole('option').map(option => option.textContent);
      expect(options).toEqual(['All Subjects', 'Conversation turn', 'Conversation', 'Product', 'Help']);
    });

    it('sends the picked subject to the filter hook', async () => {
      renderFeedbackTab();

      await userEvent.click(screen.getByTestId('feedback-subject-filter-select'));
      await userEvent.click(screen.getByRole('option', { name: 'Help' }));

      expect(defaultFiltersReturn.setSubject).toHaveBeenCalledWith('help');
    });

    it('clears the filter rather than sending the sentinel', async () => {
      mocks.useFeedbackFilters.mockReturnValue({
        ...defaultFiltersReturn,
        filters: { ...defaultFiltersReturn.filters, subject: 'help' },
      });

      renderFeedbackTab();

      await userEvent.click(screen.getByTestId('feedback-subject-filter-select'));
      await userEvent.click(screen.getByRole('option', { name: 'All Subjects' }));

      expect(defaultFiltersReturn.setSubject).toHaveBeenCalledWith(undefined);
    });
  });
});
