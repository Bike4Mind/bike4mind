import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
import { truncateUserId } from '../Users/UserIdChip';

const mocks = vi.hoisted(() => ({
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
  Link: ({
    to,
    params,
    children,
    ...rest
  }: {
    to: string;
    params?: Record<string, string>;
    children: React.ReactNode;
  }) => (
    <a href={to.replace('$userId', params?.userId ?? '')} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('papaparse', () => ({ default: { unparse: mocks.papaUnparse } }));
// The drawer reads its record through React Query and has its own test; here only the wiring counts.
vi.mock('./FeedbackDetailDrawer', () => ({
  default: (props: { feedbackId?: string; onClose: () => void }) =>
    props.feedbackId ? (
      <div data-testid="feedback-detail-drawer-stub" data-feedback-id={props.feedbackId}>
        <button onClick={props.onClose}>close drawer</button>
      </div>
    ) : null,
}));
// Covered by FeedbackTrendStrip.test.tsx; it reads its own query, which these tests do not provide.
vi.mock('./FeedbackTrendStrip', () => ({ default: () => null }));

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

const LONG_USER_ID = '6900781a8c1b76a684f80001';

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
    types: [],
    sortAscending: false,
  },
  setSearchTerm: vi.fn(),
  setStatusFilters: vi.fn(),
  setSelectedOrganizations: vi.fn(),
  setSubject: vi.fn(),
  setResolution: vi.fn(),
  setTypes: vi.fn(),
  setReceived: vi.fn(),
  setCreatedRange: vi.fn(),
  setComment: vi.fn(),
  showOnly: vi.fn(),
  toggleSortDirection: vi.fn(),
  filterParams: { sort: 'desc' },
};

const defaultPaginationReturn: UseFeedbackPaginationReturn = {
  currentPage: 1,
  handlePageChange: vi.fn(),
  itemsPerPage: 25,
  handleItemsPerPageChange: vi.fn(),
};

const makeOperationsReturn = (
  feedback: IExtendedFeedbackDocument[],
  overrides: Partial<UseFeedbackOperationsReturn> = {}
): UseFeedbackOperationsReturn => ({
  feedback,
  organizations: [],
  total: feedback.length,
  totalSettled: true,
  loading: false,
  isError: false,
  refreshFeedback: vi.fn(),
  handleStatusChange: vi.fn(),
  feedbackToClose: null,
  cancelClose: vi.fn(),
  confirmClose: vi.fn(),
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

  it('mounts the help context chip in the row', () => {
    mocks.useFeedbackOperations.mockReturnValue(makeOperationsReturn([helpFeedbackItem]));

    renderFeedbackTab();

    expect(screen.getByTestId('feedback-help-context-chip')).toHaveTextContent('features/export');
    expect(screen.getByTestId('feedback-help-outdated-chip')).toBeInTheDocument();
  });

  it('exports the help article slug as the HelpArticle CSV column', async () => {
    mocks.useFeedbackOperations.mockReturnValue(makeOperationsReturn([helpFeedbackItem]));
    mocks.getAllFeedbackForExport.mockResolvedValue({ items: [helpFeedbackItem], truncated: false });

    renderFeedbackTab();

    await userEvent.click(screen.getByRole('button', { name: 'Export CSV' }));

    await waitFor(() => expect(mocks.papaUnparse).toHaveBeenCalledTimes(1));

    const [csvRows] = mocks.papaUnparse.mock.calls[0] as [Array<Record<string, unknown>>];
    expect(csvRows[0]).toMatchObject({
      HelpArticle: 'features/export',
      Type: 'Feedback',
      Subject: 'Help',
      UserId: 'user-1',
      Username: 'reporter',
      UserEmail: 'reporter@example.com',
    });
  });

  it('exports the captured client context as CSV columns, blank for older reports', async () => {
    const withContext = {
      ...helpFeedbackItem,
      clientContext: {
        platform: 'web' as const,
        appVersion: '1.2.3',
        path: '/notebooks',
        viewport: { width: 1280, height: 720 },
        model: 'some-model',
        userAgent: 'agent/1.0',
      },
    };
    const legacy = { ...helpFeedbackItem, clientContext: undefined };
    mocks.useFeedbackOperations.mockReturnValue(makeOperationsReturn([withContext]));
    mocks.getAllFeedbackForExport.mockResolvedValue({ items: [withContext, legacy], truncated: false });

    renderFeedbackTab();

    await userEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    await waitFor(() => expect(mocks.papaUnparse).toHaveBeenCalledTimes(1));

    const [csvRows] = mocks.papaUnparse.mock.calls[0] as [Array<Record<string, unknown>>];
    expect(csvRows[0]).toMatchObject({
      Platform: 'web',
      AppVersion: '1.2.3',
      Page: '/notebooks',
      Viewport: '1280x720',
      Model: 'some-model',
      UserAgent: 'agent/1.0',
    });
    expect(csvRows[1]).toMatchObject({
      Platform: '',
      AppVersion: '',
      Page: '',
      Viewport: '',
      Model: '',
      UserAgent: '',
    });
  });

  // The hook and the subject mapping are unit-tested on their own; what only a mounted render can
  // show is that the chip is actually wired to the setter, and that its options carry the subject
  // values rather than the labels an operator reads.
  describe('subject filter', () => {
    beforeEach(() => {
      mocks.useFeedbackOperations.mockReturnValue(makeOperationsReturn([makeFeedbackItem()]));
    });

    it('offers every subject the server accepts', async () => {
      renderFeedbackTab();

      await userEvent.click(screen.getByTestId('admin-filter-feedback-subject'));

      const options = within(screen.getByTestId('admin-filter-feedback-subject-menu'))
        .getAllByRole('menuitemradio')
        .map(option => option.textContent);
      expect(options).toEqual(['Conversation turn', 'Conversation', 'Product', 'Help']);
    });

    it('sends the picked subject to the filter hook', async () => {
      renderFeedbackTab();

      await userEvent.click(screen.getByTestId('admin-filter-feedback-subject'));
      await userEvent.click(screen.getByTestId('admin-filter-feedback-subject-help'));

      expect(defaultFiltersReturn.setSubject).toHaveBeenCalledWith('help');
    });

    it('clears the filter back to every subject', async () => {
      mocks.useFeedbackFilters.mockReturnValue({
        ...defaultFiltersReturn,
        filters: { ...defaultFiltersReturn.filters, subject: 'help' },
      });

      renderFeedbackTab();

      await userEvent.click(screen.getByTestId('admin-filter-clear-feedback-subject-btn'));

      expect(defaultFiltersReturn.setSubject).toHaveBeenCalledWith(undefined);
    });
  });

  describe('type filter', () => {
    beforeEach(() => {
      mocks.useFeedbackOperations.mockReturnValue(makeOperationsReturn([makeFeedbackItem()]));
    });

    it('sends the picked type to the filter hook', async () => {
      renderFeedbackTab();

      await userEvent.click(screen.getByTestId('admin-filter-feedback-type'));
      await userEvent.click(screen.getByTestId(`admin-filter-feedback-type-${FeedbackType.THUMBS_DOWN}`));

      expect(defaultFiltersReturn.setTypes).toHaveBeenCalledWith([FeedbackType.THUMBS_DOWN]);
    });
  });

  describe('received filter', () => {
    beforeEach(() => {
      mocks.useFeedbackOperations.mockReturnValue(makeOperationsReturn([makeFeedbackItem()]));
    });

    it('sends the picked window to the filter hook', async () => {
      renderFeedbackTab();

      await userEvent.click(screen.getByTestId('admin-filter-feedback-received'));
      await userEvent.click(screen.getByTestId('admin-filter-feedback-received-7d'));

      expect(defaultFiltersReturn.setReceived).toHaveBeenCalledWith('7d');
    });

    it('clears the window back to any time', async () => {
      mocks.useFeedbackFilters.mockReturnValue({
        ...defaultFiltersReturn,
        filters: { ...defaultFiltersReturn.filters, received: '7d' },
      });

      renderFeedbackTab();

      await userEvent.click(screen.getByTestId('admin-filter-clear-feedback-received-btn'));

      expect(defaultFiltersReturn.setReceived).toHaveBeenCalledWith(undefined);
    });

    it('applies a custom range from the dialog', async () => {
      renderFeedbackTab();

      await userEvent.click(screen.getByTestId('admin-filter-feedback-received'));
      await userEvent.click(screen.getByTestId('admin-filter-feedback-received-custom'));
      expect(defaultFiltersReturn.setReceived).not.toHaveBeenCalled();

      fireEvent.change(screen.getByTestId('feedback-created-range-from-input'), { target: { value: '2026-11-01' } });
      fireEvent.change(screen.getByTestId('feedback-created-range-to-input'), { target: { value: '2026-11-08' } });
      await userEvent.click(screen.getByTestId('feedback-created-range-apply-btn'));

      expect(defaultFiltersReturn.setCreatedRange).toHaveBeenCalledWith({
        createdFrom: '2026-11-01',
        createdTo: '2026-11-08',
      });
      expect(screen.queryByTestId('feedback-created-range-dialog')).not.toBeInTheDocument();
    });

    it('keeps Apply disabled while the range ends before it starts', async () => {
      renderFeedbackTab();

      await userEvent.click(screen.getByTestId('admin-filter-feedback-received'));
      await userEvent.click(screen.getByTestId('admin-filter-feedback-received-custom'));
      fireEvent.change(screen.getByTestId('feedback-created-range-from-input'), { target: { value: '2026-11-08' } });
      fireEvent.change(screen.getByTestId('feedback-created-range-to-input'), { target: { value: '2026-11-01' } });

      expect(screen.getByTestId('feedback-created-range-apply-btn')).toBeDisabled();
      expect(screen.getByText('Ends before it starts.')).toBeInTheDocument();
    });

    it('shows a set custom range on the chip, and clearing it clears the range', async () => {
      mocks.useFeedbackFilters.mockReturnValue({
        ...defaultFiltersReturn,
        filters: { ...defaultFiltersReturn.filters, createdFrom: '2020-03-01', createdTo: '2020-03-09' },
      });

      renderFeedbackTab();

      expect(screen.getByTestId('admin-filter-feedback-received')).toHaveTextContent(
        'Received: Mar 1, 2020 \u2013 Mar 9, 2020'
      );
      await userEvent.click(screen.getByTestId('admin-filter-feedback-received'));
      expect(screen.getByTestId('admin-filter-feedback-received-custom')).toHaveTextContent('Custom range\u2026');
      await userEvent.keyboard('{Escape}');
      await userEvent.click(screen.getByTestId('admin-filter-clear-feedback-received-btn'));

      expect(defaultFiltersReturn.setReceived).toHaveBeenCalledWith(undefined);
    });
  });

  describe('comment filter', () => {
    beforeEach(() => {
      mocks.useFeedbackOperations.mockReturnValue(makeOperationsReturn([makeFeedbackItem()]));
    });

    it.each([
      ['with', 'Has comment'],
      ['without', 'No comment'],
    ] as const)('sends %s to the filter hook', async (comment, label) => {
      renderFeedbackTab();

      await userEvent.click(screen.getByTestId('admin-filter-feedback-comment'));
      const option = screen.getByTestId(`admin-filter-feedback-comment-${comment}`);
      expect(option).toHaveTextContent(label);
      await userEvent.click(option);

      expect(defaultFiltersReturn.setComment).toHaveBeenCalledWith(comment);
    });
  });

  describe('status views', () => {
    beforeEach(() => {
      mocks.useFeedbackOperations.mockReturnValue(makeOperationsReturn([makeFeedbackItem()]));
    });

    it('lights New for the default status filter', () => {
      renderFeedbackTab();

      expect(screen.getByTestId('feedback-status-views-new-btn')).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByTestId('feedback-status-views-open-btn')).toHaveAttribute('aria-pressed', 'false');
    });

    it('sets New and In progress for Open, and nothing else', async () => {
      renderFeedbackTab();

      await userEvent.click(screen.getByTestId('feedback-status-views-open-btn'));

      expect(defaultFiltersReturn.setStatusFilters).toHaveBeenCalledWith({
        [FeedbackStatus.New]: true,
        [FeedbackStatus.InProgress]: true,
        [FeedbackStatus.Closed]: false,
      });
      expect(defaultFiltersReturn.showOnly).not.toHaveBeenCalled();
    });

    it('lights no view for a status set none of them match', () => {
      mocks.useFeedbackFilters.mockReturnValue({
        ...defaultFiltersReturn,
        filters: {
          ...defaultFiltersReturn.filters,
          statusFilters: {
            [FeedbackStatus.New]: false,
            [FeedbackStatus.InProgress]: false,
            [FeedbackStatus.Closed]: true,
          },
        },
      });

      renderFeedbackTab();

      for (const id of ['new', 'open', 'all']) {
        expect(screen.getByTestId(`feedback-status-views-${id}-btn`)).toHaveAttribute('aria-pressed', 'false');
      }
    });
  });

  describe('row content', () => {
    it('labels each report with its type and subject', () => {
      mocks.useFeedbackOperations.mockReturnValue(
        makeOperationsReturn([makeFeedbackItem({ type: FeedbackType.BUG, subject: 'turn' })])
      );

      renderFeedbackTab();

      const meta = screen.getByTestId('feedback-row-type-fb-1');
      expect(meta).toHaveTextContent('Bug');
      expect(screen.getByText('Conversation turn')).toBeInTheDocument();
    });

    it('shows an untyped report as Feedback', () => {
      mocks.useFeedbackOperations.mockReturnValue(makeOperationsReturn([makeFeedbackItem({ type: undefined })]));

      renderFeedbackTab();

      expect(screen.getByTestId('feedback-row-type-fb-1')).toHaveTextContent('Feedback');
    });

    it('says so when a rating carries no comment', () => {
      mocks.useFeedbackOperations.mockReturnValue(
        makeOperationsReturn([makeFeedbackItem({ type: FeedbackType.THUMBS_DOWN, content: '' })])
      );

      renderFeedbackTab();

      expect(screen.getByText('No comment')).toBeInTheDocument();
    });

    it('links the reporter to their admin profile', () => {
      mocks.useFeedbackOperations.mockReturnValue(makeOperationsReturn([makeFeedbackItem({ userId: LONG_USER_ID })]));

      renderFeedbackTab();

      expect(screen.getByTestId('feedback-row-reporter-link-fb-1')).toHaveAttribute(
        'href',
        `/admin/users/${LONG_USER_ID}`
      );
    });

    it('shows a reporter id that is not a user id as plain text', () => {
      mocks.useFeedbackOperations.mockReturnValue(makeOperationsReturn([makeFeedbackItem()]));

      renderFeedbackTab();

      expect(screen.queryByTestId('feedback-row-reporter-link-fb-1')).not.toBeInTheDocument();
      expect(screen.getByText('reporter')).toBeInTheDocument();
    });
  });

  describe('status filter', () => {
    const statusFilters = (...checked: FeedbackStatus[]) => ({
      [FeedbackStatus.New]: checked.includes(FeedbackStatus.New),
      [FeedbackStatus.InProgress]: checked.includes(FeedbackStatus.InProgress),
      [FeedbackStatus.Closed]: checked.includes(FeedbackStatus.Closed),
    });

    beforeEach(() => {
      mocks.useFeedbackOperations.mockReturnValue(makeOperationsReturn([makeFeedbackItem()]));
    });

    it('adds a picked status to the checked ones', async () => {
      renderFeedbackTab();

      expect(screen.getByTestId('admin-filter-feedback-status')).toHaveTextContent('Status: New');
      await userEvent.click(screen.getByTestId('admin-filter-feedback-status'));
      await userEvent.click(screen.getByTestId(`admin-filter-feedback-status-${FeedbackStatus.Closed}`));

      expect(defaultFiltersReturn.setStatusFilters).toHaveBeenCalledWith(
        statusFilters(FeedbackStatus.New, FeedbackStatus.Closed)
      );
    });

    // No status checked matches nothing, so clearing the chip means every status instead.
    it('checks every status when the chip is cleared', async () => {
      renderFeedbackTab();

      await userEvent.click(screen.getByTestId('admin-filter-clear-feedback-status-btn'));

      expect(defaultFiltersReturn.setStatusFilters).toHaveBeenCalledWith(
        statusFilters(FeedbackStatus.New, FeedbackStatus.InProgress, FeedbackStatus.Closed)
      );
    });

    it('checks every status when its last checked one is unpicked from the menu', async () => {
      renderFeedbackTab();

      await userEvent.click(screen.getByTestId('admin-filter-feedback-status'));
      await userEvent.click(screen.getByTestId(`admin-filter-feedback-status-${FeedbackStatus.New}`));

      expect(defaultFiltersReturn.setStatusFilters).toHaveBeenCalledTimes(1);
      expect(defaultFiltersReturn.setStatusFilters).toHaveBeenCalledWith(
        statusFilters(FeedbackStatus.New, FeedbackStatus.InProgress, FeedbackStatus.Closed)
      );
    });
  });

  describe('page frame', () => {
    beforeEach(() => {
      mocks.useFeedbackOperations.mockReturnValue(
        makeOperationsReturn([makeFeedbackItem({ userId: LONG_USER_ID })], { total: 41 })
      );
    });

    it('opens with the page header and its count', () => {
      renderFeedbackTab();

      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Feedback (41)');
    });

    it('has exactly one pager, the table footer, with no page-size radio group', () => {
      renderFeedbackTab();

      expect(screen.getAllByTestId('admin-table-footer')).toHaveLength(1);
      expect(screen.getByTestId('admin-table-range')).toHaveTextContent('1 to 1 of 41');
      expect(screen.queryAllByRole('radio')).toHaveLength(0);
    });

    it('passes a page-size change from the footer to the pagination hook', async () => {
      renderFeedbackTab();

      await userEvent.click(within(screen.getByTestId('admin-table-page-size')).getByRole('combobox'));
      await userEvent.click(screen.getByTestId('admin-table-page-size-50'));

      expect(defaultPaginationReturn.handleItemsPerPageChange).toHaveBeenCalledWith(50);
    });

    it('flips the date order from the Created header and goes back to page 1', async () => {
      renderFeedbackTab();

      await userEvent.click(screen.getByTestId('admin-table-sort-createdAt-btn'));

      expect(defaultFiltersReturn.toggleSortDirection).toHaveBeenCalledTimes(1);
      expect(defaultPaginationReturn.handlePageChange).toHaveBeenCalledWith(1);
    });

    it('sends the search box text to the filter hook', () => {
      renderFeedbackTab();

      fireEvent.change(screen.getByTestId('feedback-search-input'), { target: { value: 'export broke' } });

      expect(defaultFiltersReturn.setSearchTerm).toHaveBeenCalledWith('export broke');
    });

    it('scrolls the table sideways inside its own container instead of crushing columns', () => {
      renderFeedbackTab();

      expect(screen.getByRole('region', { name: 'Feedback' })).toHaveStyle({ overflowX: 'auto' });
      expect(screen.getByTestId('feedback-table')).toHaveStyle({ minWidth: '44rem' });
    });

    it('shows the reporter id truncated, with the full id behind the copy chip', () => {
      renderFeedbackTab();

      const chip = screen.getByTestId('admin-user-id-chip');
      expect(chip).toHaveTextContent(truncateUserId(LONG_USER_ID));
      expect(chip).not.toHaveTextContent(LONG_USER_ID);
    });
  });

  describe('row actions', () => {
    const item = makeFeedbackItem();

    it('keeps delete out of the rows, with no danger confirm on the page', () => {
      mocks.useFeedbackOperations.mockReturnValue(makeOperationsReturn([item]));

      renderFeedbackTab();

      expect(screen.queryAllByRole('button', { name: /delete/i, hidden: true })).toHaveLength(0);
      // The danger tone belongs to the delete dialog's confirm, which only a row menu opens.
      expect(document.body.querySelector('[data-tone="danger"]')).toBeNull();
    });

    it('offers delete from the row menu', async () => {
      const operations = makeOperationsReturn([item]);
      mocks.useFeedbackOperations.mockReturnValue(operations);

      renderFeedbackTab();

      fireEvent.click(screen.getByTestId('feedback-row-actions-fb-1'));
      fireEvent.click(await screen.findByTestId('feedback-row-delete-fb-1'));

      expect(operations.handleDeleteFeedbackClick).toHaveBeenCalledWith(item);
    });

    describe('links in the row menu', () => {
      const openRowMenu = () => fireEvent.click(screen.getByTestId('feedback-row-actions-fb-1'));
      const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

      afterEach(() => {
        if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard);
        else Reflect.deleteProperty(navigator, 'clipboard');
      });

      it('copies an absolute link to the report', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
        mocks.useFeedbackOperations.mockReturnValue(makeOperationsReturn([item]));

        renderFeedbackTab();
        openRowMenu();
        fireEvent.click(await screen.findByTestId('feedback-row-copy-link-fb-1'));

        await waitFor(() =>
          expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/admin?tab=feedback&feedbackId=fb-1`)
        );
        expect(mocks.toastSuccess).toHaveBeenCalledWith('Link to this report copied');
      });

      it.each([
        ['a turn', { questId: 'quest-1' }, '/notebooks/sess-1?questId=quest-1', 'Open the conversation at this turn'],
        ['a session', {}, '/notebooks/sess-1', 'Open the conversation'],
      ])('opens the conversation a report on %s is about, in a new tab', async (_, questFields, href, label) => {
        mocks.useFeedbackOperations.mockReturnValue(
          makeOperationsReturn([makeFeedbackItem({ sessionId: 'sess-1', ...questFields })])
        );

        renderFeedbackTab();
        openRowMenu();
        const open = await screen.findByTestId('feedback-row-open-conversation-fb-1');

        expect(open).toHaveAttribute('href', href);
        expect(open).toHaveAttribute('target', '_blank');
        expect(open).toHaveAttribute('rel', 'noopener noreferrer');
        expect(open.textContent).toBe(label);
      });

      it('offers an email draft to the reporter, with the report quoted', async () => {
        mocks.useFeedbackOperations.mockReturnValue(makeOperationsReturn([item]));

        renderFeedbackTab();
        openRowMenu();
        const email = await screen.findByTestId('feedback-row-email-reporter-fb-1');

        expect(email.textContent).toBe('Email reporter');
        expect(email).not.toHaveAttribute('target');
        const href = email.getAttribute('href') ?? '';
        expect(href).toMatch(/^mailto:reporter%40example\.com\?subject=/);
        expect(decodeURIComponent(href.split('&body=')[1])).toBe('> Some feedback content');
      });

      it('lists the email action with the links, above the delete divider', async () => {
        mocks.useFeedbackOperations.mockReturnValue(makeOperationsReturn([makeFeedbackItem({ sessionId: 'sess-1' })]));

        renderFeedbackTab();
        openRowMenu();
        const conversation = await screen.findByTestId('feedback-row-open-conversation-fb-1');
        const email = screen.getByTestId('feedback-row-email-reporter-fb-1');
        const divider = screen.getByRole('separator');

        expect(conversation.compareDocumentPosition(email) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(email.compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      });

      it('hides the email action for a report with no email', async () => {
        mocks.useFeedbackOperations.mockReturnValue(makeOperationsReturn([makeFeedbackItem({ userEmail: '' })]));

        renderFeedbackTab();
        openRowMenu();

        expect(await screen.findByTestId('feedback-row-copy-link-fb-1')).toBeInTheDocument();
        expect(screen.queryByTestId('feedback-row-email-reporter-fb-1')).toBeNull();
      });

      it('offers no conversation for a report with no session', async () => {
        mocks.useFeedbackOperations.mockReturnValue(makeOperationsReturn([item]));

        renderFeedbackTab();
        openRowMenu();

        expect(await screen.findByTestId('feedback-row-copy-link-fb-1')).toBeInTheDocument();
        expect(screen.queryByTestId('feedback-row-open-conversation-fb-1')).toBeNull();
      });
    });

    it('confirms a delete through the action dialog, which asks for a reason first', async () => {
      const operations = makeOperationsReturn([item], { openDeleteFeedbackModal: true, feedbackToDelete: 'fb-1' });
      mocks.useFeedbackOperations.mockReturnValue(operations);

      renderFeedbackTab();

      expect(await screen.findByTestId('feedback-delete-dialog')).toHaveTextContent('reporter');
      expect(screen.getByTestId('feedback-delete-dialog-confirm-btn')).toBeDisabled();
      expect(screen.getByTestId('feedback-delete-dialog-confirm-btn')).toHaveAttribute('data-tone', 'danger');

      fireEvent.click(screen.getByTestId('feedback-delete-dialog-reason-input-preset-0'));
      fireEvent.click(screen.getByTestId('feedback-delete-dialog-confirm-btn'));

      await waitFor(() => expect(operations.confirmDeleteFeedback).toHaveBeenCalledTimes(1));
    });
  });

  describe('data states', () => {
    it('offers to clear the filters when they match nothing', async () => {
      mocks.useFeedbackOperations.mockReturnValue(makeOperationsReturn([]));

      renderFeedbackTab();

      expect(screen.getByTestId('admin-empty-state')).toHaveTextContent('No feedback matches these filters');
      await userEvent.click(screen.getByTestId('feedback-empty-clear-btn'));

      expect(defaultFiltersReturn.showOnly).toHaveBeenCalledWith({
        statusFilters: {
          [FeedbackStatus.New]: true,
          [FeedbackStatus.InProgress]: true,
          [FeedbackStatus.Closed]: true,
        },
      });
    });

    it('shows a retry in place of the rows when the list fails', async () => {
      const operations = makeOperationsReturn([], { isError: true });
      mocks.useFeedbackOperations.mockReturnValue(operations);

      renderFeedbackTab();

      expect(screen.getByTestId('admin-error-state')).toHaveTextContent('Could not load feedback.');
      await userEvent.click(screen.getByTestId('admin-error-retry-btn'));

      expect(operations.refreshFeedback).toHaveBeenCalled();
    });
  });

  describe('a page from the URL past the last one', () => {
    const onPage = (currentPage: number) => {
      const handlePageChange = vi.fn();
      mocks.useFeedbackPagination.mockReturnValue({ ...defaultPaginationReturn, currentPage, handlePageChange });
      return handlePageChange;
    };

    it('moves to the last page once the total has settled', () => {
      const handlePageChange = onPage(5);
      mocks.useFeedbackOperations.mockReturnValue(makeOperationsReturn([makeFeedbackItem()], { total: 70 }));

      renderFeedbackTab();

      expect(handlePageChange).toHaveBeenCalledWith(3);
    });

    it('is left alone while the total still belongs to a previous query', () => {
      const handlePageChange = onPage(5);
      mocks.useFeedbackOperations.mockReturnValue(
        makeOperationsReturn([makeFeedbackItem()], { total: 0, totalSettled: false })
      );

      renderFeedbackTab();

      expect(handlePageChange).not.toHaveBeenCalled();
    });

    it('leaves a reachable page alone', () => {
      const handlePageChange = onPage(3);
      mocks.useFeedbackOperations.mockReturnValue(makeOperationsReturn([makeFeedbackItem()], { total: 70 }));

      renderFeedbackTab();

      expect(handlePageChange).not.toHaveBeenCalled();
    });
  });

  describe('detail drawer', () => {
    const item = makeFeedbackItem();
    const lastSearch = (navigate: ReturnType<typeof vi.fn>) => {
      const [{ search, replace }] = navigate.mock.calls.at(-1) as [
        { search: (previous: Record<string, unknown>) => Record<string, unknown>; replace: boolean },
      ];
      return { search: search({ tab: 'feedback', feedbackStatus: 'New' }), replace };
    };

    beforeEach(() => {
      mocks.useFeedbackOperations.mockReturnValue(makeOperationsReturn([item]));
    });

    it('opens the report a row click names, keeping the rest of the URL', async () => {
      const navigate = vi.fn();
      mocks.useNavigate.mockReturnValue(navigate);

      renderFeedbackTab();
      await userEvent.click(screen.getByText('Some feedback content'));

      expect(lastSearch(navigate)).toEqual({
        search: { tab: 'feedback', feedbackStatus: 'New', feedbackId: 'fb-1' },
        replace: true,
      });
    });

    it('opens the report from the keyboard with Enter', async () => {
      const navigate = vi.fn();
      mocks.useNavigate.mockReturnValue(navigate);

      renderFeedbackTab();
      screen.getByTestId('feedback-row-fb-1').focus();
      await userEvent.keyboard('{Enter}');

      expect(lastSearch(navigate).search).toMatchObject({ feedbackId: 'fb-1' });
    });

    it('does not open the drawer from the status select or the row menu', async () => {
      const navigate = vi.fn();
      mocks.useNavigate.mockReturnValue(navigate);

      renderFeedbackTab();
      await userEvent.click(screen.getByTestId('feedback-row-status-select-fb-1'));
      fireEvent.click(screen.getByTestId('feedback-row-actions-fb-1'));

      expect(navigate).not.toHaveBeenCalled();
    });

    it('opens from ?feedbackId= and marks the row as the open one', () => {
      mocks.useSearch.mockReturnValue({ feedbackId: 'fb-1' });

      renderFeedbackTab();

      expect(screen.getByTestId('feedback-detail-drawer-stub')).toHaveAttribute('data-feedback-id', 'fb-1');
      expect(screen.getByTestId('feedback-row-fb-1')).toHaveAttribute('aria-current', 'true');
      expect(screen.getByTestId('feedback-row-fb-1')).toHaveAttribute('aria-selected', 'false');
    });

    it('clears ?feedbackId= on close and returns focus to the row', async () => {
      const navigate = vi.fn();
      mocks.useNavigate.mockReturnValue(navigate);
      mocks.useSearch.mockReturnValue({ feedbackId: 'fb-1' });

      const { rerender } = renderFeedbackTab();
      await userEvent.click(screen.getByText('close drawer'));
      expect(lastSearch(navigate).search).toMatchObject({ feedbackId: undefined });

      mocks.useSearch.mockReturnValue({});
      rerender(<FeedbackTab />);

      expect(screen.getByTestId('feedback-row-fb-1')).toHaveFocus();
    });

    it('returns focus to the table region when the closed report has no row', async () => {
      const navigate = vi.fn();
      mocks.useNavigate.mockReturnValue(navigate);
      mocks.useSearch.mockReturnValue({ feedbackId: 'not-in-the-list' });

      const { rerender } = renderFeedbackTab();
      await userEvent.click(screen.getByText('close drawer'));

      mocks.useSearch.mockReturnValue({});
      rerender(<FeedbackTab />);

      expect(screen.getByTestId('feedback-table-region')).toHaveFocus();
    });
  });
});
