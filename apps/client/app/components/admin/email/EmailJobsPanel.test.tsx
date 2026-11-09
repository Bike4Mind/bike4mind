import { fireEvent, render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';

const mocks = vi.hoisted(() => ({
  jobs: {
    data: undefined as unknown,
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  },
  lastParams: undefined as unknown,
}));

vi.mock('@client/app/hooks/data/emailMarketing', () => ({
  useEmailJobs: (params: unknown) => {
    mocks.lastParams = params;
    return mocks.jobs;
  },
  useCancelEmailJob: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCloneEmailJob: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('./EmailJobDetail', () => ({
  default: ({ jobId }: { jobId?: string }) => <div data-testid="email-job-detail-stub" data-job-id={jobId ?? 'new'} />,
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

const setStartDate = (value: string) => {
  const input = screen.getByTestId('date-range-start-input').querySelector('input') as HTMLInputElement;
  fireEvent.change(input, { target: { value } });
};

describe('EmailJobsPanel', () => {
  beforeEach(() => {
    Object.assign(mocks.jobs, { data: { data: [] }, isLoading: false, isError: false, isFetching: false });
    mocks.jobs.refetch.mockClear();
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

  it('shows an error state whose retry refetches the campaigns', () => {
    Object.assign(mocks.jobs, { data: undefined, isError: true });
    renderPanel();

    expect(screen.getByTestId('admin-error-state')).toHaveTextContent('Could not load campaigns.');
    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(mocks.jobs.refetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the rows on screen when a background refetch fails', () => {
    Object.assign(mocks.jobs, { data: { data: [job] }, isError: true });
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
    mocks.jobs.data = { data: [job] };
    renderPanel();

    expect(screen.queryByTestId('admin-empty-state')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('edit-job-j1'));
    expect(screen.getByTestId('email-job-detail-stub')).toHaveAttribute('data-job-id', 'j1');
  });
});
