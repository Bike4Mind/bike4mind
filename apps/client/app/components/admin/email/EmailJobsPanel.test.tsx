import { fireEvent, render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EmailJobOverallStatus, EmailJobStatus } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';

const mocks = vi.hoisted(() => ({
  jobs: {
    data: undefined as unknown,
    isLoading: false,
    isError: false,
    isPlaceholderData: false,
    refetch: vi.fn(),
  },
  lastParams: undefined as unknown,
  cancel: vi.fn(),
  clone: vi.fn(),
}));

vi.mock('@client/app/hooks/data/emailMarketing', () => ({
  useEmailJobs: (params: unknown) => {
    mocks.lastParams = params;
    return mocks.jobs;
  },
  useCancelEmailJob: () => ({ mutateAsync: mocks.cancel, isPending: false }),
  useCloneEmailJob: () => ({ mutateAsync: mocks.clone, isPending: false }),
}));
vi.mock('./EmailJobDetail', () => ({
  default: ({ jobId, onBack }: { jobId?: string; onBack?: () => void }) => (
    <div data-testid="email-job-detail-stub" data-job-id={jobId ?? 'new'}>
      <button data-testid="email-job-detail-stub-back" onClick={onBack} />
    </div>
  ),
}));

import EmailJobsPanel from './EmailJobsPanel';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderPanel = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <EmailJobsPanel />
    </CssVarsProvider>
  );

const job = {
  id: 'j1',
  name: 'Spring launch',
  createdAt: '2026-03-01T00:00:00.000Z',
  isTestMode: false,
  recipientFilter: { allUsers: true },
  recipientCount: 0,
  sentCount: 0,
  failedCount: 0,
  openedCount: 0,
  status: 'draft',
};

const pageOf = (rows: unknown[], total = rows.length) => ({
  data: rows,
  meta: { currentPage: 1, totalPages: Math.ceil(total / 25), total },
});

const setStartDate = (value: string) => {
  fireEvent.click(screen.getByTestId('date-range-start-input-set-btn'));
  fireEvent.change(screen.getByTestId('date-range-start-input'), { target: { value } });
};

describe('EmailJobsPanel', () => {
  beforeEach(() => {
    Object.assign(mocks.jobs, { data: pageOf([]), isLoading: false, isError: false, isPlaceholderData: false });
    mocks.jobs.refetch.mockClear();
    mocks.cancel.mockReset();
    mocks.clone.mockReset();
  });

  it('starts with a toolbar row that holds only the filters and new campaign buttons', () => {
    const { container } = renderPanel();
    const toolbar = container.firstElementChild?.firstElementChild as HTMLElement;

    expect(Array.from(toolbar.children)).toEqual([
      screen.getByTestId('filter-campaigns-btn'),
      screen.getByTestId('new-campaign-btn'),
    ]);
    expect(screen.getByTestId('new-campaign-btn')).toHaveTextContent('New campaign');
  });

  it('adds no inset of its own, so the table lines up with the page title', () => {
    const { container } = renderPanel();

    expect(getComputedStyle(container.firstElementChild as HTMLElement).paddingLeft).toBe('0');
  });

  it('shows the loading state while campaigns load', () => {
    mocks.jobs.isLoading = true;
    renderPanel();

    expect(screen.getByTestId('email-campaigns-loading')).toHaveTextContent('Loading campaigns');
  });

  it('shows skeleton rows while the previous page stands in for the next one', () => {
    mocks.jobs.isPlaceholderData = true;
    renderPanel();

    expect(screen.getAllByTestId('admin-table-skeleton-row').length).toBeGreaterThan(0);
  });

  it('shows an error state whose retry refetches the campaigns', () => {
    Object.assign(mocks.jobs, { data: undefined, isError: true });
    renderPanel();

    expect(screen.getByTestId('admin-error-state')).toHaveTextContent('Could not load campaigns.');
    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(mocks.jobs.refetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the rows on screen when a background refetch fails', () => {
    Object.assign(mocks.jobs, { data: pageOf([job]), isError: true });
    renderPanel();

    expect(screen.getByTestId('edit-job-j1')).toBeInTheDocument();
    expect(screen.queryByTestId('admin-error-state')).not.toBeInTheDocument();
  });

  it('shows an empty state whose action opens a new campaign', () => {
    renderPanel();

    const empty = screen.getByTestId('admin-empty-state');
    expect(empty).toHaveTextContent('No campaigns yet');
    fireEvent.click(within(empty).getByTestId('email-campaigns-empty-create-btn'));
    expect(screen.getByTestId('email-job-detail-stub')).toHaveAttribute('data-job-id', 'new');
  });

  it('shows empty date labels and sends no date bounds until one is set', () => {
    renderPanel();
    fireEvent.click(screen.getByTestId('filter-campaigns-btn'));
    expect(screen.getByTestId('date-range-start-input-empty')).toHaveTextContent('From any date');
    expect(screen.getByTestId('date-range-end-input-empty')).toHaveTextContent('To any date');
    expect(mocks.lastParams).toMatchObject({ startDate: undefined, endDate: undefined });
  });

  it('says when the filters match nothing and offers to clear them', () => {
    renderPanel();
    fireEvent.click(screen.getByTestId('filter-campaigns-btn'));
    setStartDate('2026-01-01');

    const empty = screen.getByTestId('admin-empty-state');
    expect(empty).toHaveTextContent('No campaigns match these filters');
    expect(mocks.lastParams).toMatchObject({ startDate: '2026-01-01' });

    fireEvent.click(within(empty).getByTestId('email-campaigns-empty-clear-filters-btn'));
    expect(mocks.lastParams).toMatchObject({ startDate: undefined, excludeTest: false });
    expect(screen.getByTestId('admin-empty-state')).toHaveTextContent('No campaigns yet');
  });

  it('lists campaigns and opens one in the detail view', () => {
    mocks.jobs.data = pageOf([job]);
    renderPanel();

    expect(screen.queryByTestId('admin-empty-state')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('edit-job-j1'));
    expect(screen.getByTestId('email-job-detail-stub')).toHaveAttribute('data-job-id', 'j1');
  });

  it('renders each campaign row inside the admin data table with the actions its status allows', () => {
    mocks.jobs.data = pageOf([
      {
        ...job,
        id: 'j2',
        name: 'Weekly digest',
        status: EmailJobStatus.SCHEDULED,
        scheduledAt: '2026-12-01T09:00:00.000Z',
      },
      {
        ...job,
        id: 'j3',
        name: 'Autumn recap',
        status: EmailJobStatus.COMPLETED,
        overallStatus: EmailJobOverallStatus.COMPLETE,
        recipientCount: 4,
        sentCount: 4,
        openedCount: 1,
      },
    ]);
    renderPanel();

    const table = screen.getByTestId('email-campaigns-table');
    const scheduledRow = within(table).getByText('Weekly digest').closest('tr') as HTMLElement;
    const completeRow = within(table).getByText('Autumn recap').closest('tr') as HTMLElement;

    // Cancel sits in Status, outside the hover-revealed row actions, so it is always visible.
    expect(within(scheduledRow).getByTestId('cancel-scheduled-job-j2')).toBeInTheDocument();
    expect(
      within(within(scheduledRow).getByTestId('admin-table-row-actions')).queryByTestId('cancel-scheduled-job-j2')
    ).not.toBeInTheDocument();
    expect(within(completeRow).getByText('4 / 4')).toBeInTheDocument();
    expect(within(completeRow).getByText('25.0%')).toBeInTheDocument();
    expect(
      within(within(completeRow).getByTestId('admin-table-row-actions'))
        .getAllByRole('button')
        .map(button => button.getAttribute('data-testid'))
    ).toEqual(['edit-job-j3', 'clone-job-j3']);
  });

  it('pages the campaigns on the server and reports the server total', () => {
    mocks.jobs.data = pageOf([job], 30);
    renderPanel();

    expect(mocks.lastParams).toMatchObject({ page: 1, limit: 25 });
    expect(screen.getByTestId('admin-table-range')).toHaveTextContent('1 to 1 of 30');

    fireEvent.click(screen.getByTestId('admin-table-next-btn'));
    expect(mocks.lastParams).toMatchObject({ page: 2, limit: 25 });

    fireEvent.click(screen.getByTestId('filter-campaigns-btn'));
    setStartDate('2026-01-01');
    expect(mocks.lastParams).toMatchObject({ page: 1, startDate: '2026-01-01' });
  });

  it.each([
    ['clone', 'draft', 'clone-job-j1', () => mocks.clone],
    ['cancel', 'scheduled', 'cancel-scheduled-job-j1', () => mocks.cancel],
  ])('shows a failed row %s inline instead of rejecting unhandled', async (_name, status, testId, mutation) => {
    mocks.jobs.data = pageOf([{ ...job, status }]);
    mutation().mockRejectedValue(new Error('Network Error'));
    renderPanel();

    fireEvent.click(screen.getByTestId(testId));

    expect(await screen.findByTestId('email-campaigns-action-error')).toHaveTextContent('Network Error');
  });

  it('drops a row action error when a campaign is opened', async () => {
    mocks.jobs.data = pageOf([job]);
    mocks.clone.mockRejectedValue(new Error('Network Error'));
    renderPanel();
    fireEvent.click(screen.getByTestId('clone-job-j1'));
    await screen.findByTestId('email-campaigns-action-error');

    fireEvent.click(screen.getByTestId('edit-job-j1'));
    fireEvent.click(screen.getByTestId('email-job-detail-stub-back'));

    expect(screen.queryByTestId('email-campaigns-action-error')).toBeNull();
  });
});
