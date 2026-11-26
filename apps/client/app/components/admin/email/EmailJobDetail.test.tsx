import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { AxiosError, AxiosHeaders } from 'axios';
import { EmailJobOverallStatus, EmailJobStatus } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import EmailJobDetail from './EmailJobDetail';

type Recipient = { id: string; email: string; name?: string; type: 'user' };
type PreviewResult = {
  totalCount: number;
  eligibleCount: number;
  excludedCount: number;
  recipients: Recipient[];
  hasMore: boolean;
};

const pad = (n: number) => String(n).padStart(2, '0');
const makeRecipients = (count: number): Recipient[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `id${pad(i + 1)}`,
    email: `u${pad(i + 1)}@example.com`,
    name: i % 2 === 0 ? `User ${pad(i + 1)}` : undefined,
    type: 'user',
  }));

const m = vi.hoisted(() => ({
  job: undefined as Record<string, unknown> | undefined,
  preview: vi.fn(),
  send: vi.fn(),
  schedule: vi.fn(),
  cancel: vi.fn(),
  cancelPending: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
}));

const mutation = (mutateAsync: (...args: unknown[]) => unknown) => ({ mutateAsync, isPending: false });

vi.mock('@client/app/hooks/data/emailMarketing', () => ({
  useEmailJob: () => ({ data: m.job, isLoading: false }),
  useEmailTemplates: () => ({ data: { data: [{ id: 't1', name: 'Template one', category: 'marketing' }] } }),
  useEmailTemplate: (id: string) => ({
    data: id ? { id, subject: 'Hi {{userName}}', htmlContent: '<p>Hello {{userName}}</p>' } : undefined,
  }),
  useCreateEmailJob: () => mutation(m.create),
  useUpdateEmailJob: () => mutation(m.update),
  useSendEmailJob: () => mutation(m.send),
  useCancelEmailJob: () => mutation(m.cancel),
  useCancelPendingEmails: () => mutation(m.cancelPending),
  useScheduleEmailJob: () => mutation(m.schedule),
  usePreviewRecipients: () => mutation(m.preview),
}));

vi.mock('./EmailStatusSummary', () => ({ default: () => <div data-testid="status-summary-stub" /> }));
vi.mock('./EmailActivityHistory', () => ({ default: () => <div data-testid="activity-history-stub" /> }));
vi.mock('./EmailPreviewModal', () => ({ default: () => null }));

const appTheme = extendTheme({ ...getThemeConfig() });
const renderDetail = (jobId?: string) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <EmailJobDetail jobId={jobId} onBack={() => {}} />
    </CssVarsProvider>
  );

const draftJob = (overallStatus = EmailJobOverallStatus.DRAFT) => ({
  id: 'job1',
  name: 'Draft job',
  templateId: 't1',
  subject: '',
  recipientFilter: { allUsers: true },
  isTestMode: false,
  status: EmailJobStatus.DRAFT,
  overallStatus,
  recipientCount: 0,
  sentCount: 0,
  failedCount: 0,
});

const previewResult = (overrides: Partial<PreviewResult> = {}): PreviewResult => ({
  totalCount: 32,
  eligibleCount: 30,
  excludedCount: 2,
  recipients: makeRecipients(30),
  hasMore: false,
  ...overrides,
});

const badRequest = (error: string) =>
  new AxiosError('Request failed with status code 400', 'ERR_BAD_REQUEST', undefined, undefined, {
    status: 400,
    statusText: 'Bad Request',
    data: { error },
    headers: {},
    config: { headers: new AxiosHeaders() },
  });

const EMAIL = /^u\d\d@example\.com$/;
const emailCells = (scope: HTMLElement = document.body) => within(scope).queryAllByText(EMAIL);
// The preview panel's recipient Select keeps its options mounted, so skip them.
const outsideDialogs = () => emailCells().filter(el => !el.closest('[role="dialog"], [role="option"]'));

const clickNext = (dialog: HTMLElement) =>
  fireEvent.click(within(dialog).getByRole('button', { name: /^next( page)?$/i }));
const closeDialog = (dialog: HTMLElement) =>
  fireEvent.click(within(dialog).getByTestId(`${dialog.getAttribute('data-testid')}-close-btn`));

const openViewAll = async () => {
  fireEvent.click(await screen.findByRole('button', { name: 'View All 30 Recipients' }));
  return screen.findByRole('dialog');
};

describe('EmailJobDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.job = draftJob();
    m.preview.mockResolvedValue(previewResult());
  });

  it('renders an empty create form with no status summary and no recipient fetch', () => {
    m.job = undefined;
    renderDetail();

    expect(screen.getByPlaceholderText('Weekly Newsletter - Dec 2024')).toHaveValue('');
    expect(screen.queryByTestId('status-summary-stub')).toBeNull();
    expect(m.preview).not.toHaveBeenCalled();
  });

  it('loads the job into the form and fetches the recipient preview', async () => {
    renderDetail('job1');

    expect(screen.getByDisplayValue('Draft job')).toBeInTheDocument();
    expect(screen.getByTestId('status-summary-stub')).toBeInTheDocument();
    await waitFor(() =>
      expect(m.preview).toHaveBeenCalledWith({ recipientFilter: { allUsers: true }, category: 'marketing' })
    );
  });

  it('shows the first five recipients inline with the counts', async () => {
    renderDetail('job1');

    await screen.findByRole('button', { name: 'View All 30 Recipients' });
    expect(outsideDialogs().map(el => el.textContent)).toEqual([
      'u01@example.com',
      'u02@example.com',
      'u03@example.com',
      'u04@example.com',
      'u05@example.com',
    ]);
    const countFor = (label: string) => screen.getByText(label).previousElementSibling?.textContent;
    expect(countFor('Total')).toBe('32');
    expect(countFor('Eligible')).toBe('30');
    expect(countFor('Excluded')).toBe('2');
    expect(screen.getByText('User 01')).toBeInTheDocument();
    expect(screen.getByTestId('email-job-recipients-inline-table-frame')).toHaveAttribute('data-framed', 'false');
  });

  it('narrows the inline list by search and says when nothing matches', async () => {
    renderDetail('job1');
    await screen.findByRole('button', { name: 'View All 30 Recipients' });
    const search = screen.getByPlaceholderText('Search recipients...');

    fireEvent.change(search, { target: { value: 'u07' } });
    expect(outsideDialogs().map(el => el.textContent)).toEqual(['u07@example.com']);
    expect(screen.queryByRole('button', { name: /View All/ })).toBeNull();

    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(outsideDialogs()).toHaveLength(0);
    expect(screen.getByText('No recipients match your search')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('email-job-recipients-inline-table-clear-search-btn'));
    expect(search).toHaveValue('');
    expect(outsideDialogs()).toHaveLength(5);
  });

  it('pages the View All dialog 25 at a time and resets to page one on search', async () => {
    renderDetail('job1');
    const dialog = await openViewAll();

    expect(within(dialog).getByText('Recipients (30 total)')).toBeInTheDocument();
    expect(dialog).toHaveAttribute('data-testid', 'email-job-recipients-dialog');
    expect(within(dialog).getByTestId('email-job-recipients-table')).toBeInTheDocument();
    expect(emailCells(dialog)).toHaveLength(25);
    expect(emailCells(dialog)[0]).toHaveTextContent('u01@example.com');

    clickNext(dialog);
    expect(emailCells(dialog).map(el => el.textContent)).toEqual([
      'u26@example.com',
      'u27@example.com',
      'u28@example.com',
      'u29@example.com',
      'u30@example.com',
    ]);

    // Every row matches, so the result still spans two pages and only the reset brings back page one.
    const modalSearch = within(dialog).getByPlaceholderText('Search by email or name...');
    fireEvent.change(modalSearch, { target: { value: 'example.com' } });
    expect(emailCells(dialog)).toHaveLength(25);
    expect(emailCells(dialog)[0]).toHaveTextContent('u01@example.com');

    fireEvent.change(modalSearch, { target: { value: 'u2' } });
    expect(emailCells(dialog)).toHaveLength(10);
    expect(emailCells(dialog)[0]).toHaveTextContent('u20@example.com');

    closeDialog(dialog);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('notes a truncated preview in the View All dialog', async () => {
    m.preview.mockResolvedValue(previewResult({ eligibleCount: 40, hasMore: true }));
    renderDetail('job1');
    fireEvent.click(await screen.findByRole('button', { name: 'View All 30 Recipients' }));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByText(/Showing first 30 of 40/)).toBeInTheDocument();
  });

  it('offers no View All for an empty recipient list', async () => {
    m.preview.mockResolvedValue(previewResult({ totalCount: 0, eligibleCount: 0, excludedCount: 0, recipients: [] }));
    renderDetail('job1');

    await waitFor(() => expect(m.preview).toHaveBeenCalled());
    await screen.findByText('Eligible');
    expect(screen.queryByRole('button', { name: /View All/ })).toBeNull();
    expect(emailCells()).toHaveLength(0);
    expect(screen.getByText('No recipients found')).toBeInTheDocument();

    m.preview.mockClear();
    fireEvent.click(screen.getByTestId('email-job-recipients-inline-table-refresh-btn'));
    await waitFor(() => expect(m.preview).toHaveBeenCalledTimes(1));
  });

  it('opens the fullscreen preview, previews as a chosen recipient, and closes', async () => {
    renderDetail('job1');
    await screen.findByRole('button', { name: 'View All 30 Recipients' });

    fireEvent.click(screen.getByTestId('email-job-fullscreen-btn'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('data-testid', 'email-job-fullscreen-preview-dialog');
    expect(within(dialog).getByTestId('email-job-preview-recipient-select')).toBeInTheDocument();
    expect(within(dialog).getByText('Subject:')).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('combobox'));
    const options = await screen.findAllByRole('option');
    expect(options).toHaveLength(30);
    fireEvent.click(screen.getByRole('option', { name: 'u03@example.com - User 03' }));
    expect(within(dialog).getByText('Previewing as: User 03')).toBeInTheDocument();

    for (const title of ['Email Preview', 'Email Preview Fullscreen']) {
      const frame = screen.getByTitle(title);
      expect(frame.getAttribute('sandbox')).toBe('');
    }

    closeDialog(dialog);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('locks the form while the job is sending', async () => {
    m.job = draftJob(EmailJobOverallStatus.SENDING);
    renderDetail('job1');

    expect(screen.getByDisplayValue('Draft job')).toBeDisabled();
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled();
    expect(screen.queryByRole('button', { name: /^Save$/ })).toBeNull();
    await waitFor(() => expect(m.preview).toHaveBeenCalled());
  });

  it('never sends or schedules while browsing the recipients', async () => {
    renderDetail('job1');
    const dialog = await openViewAll();
    clickNext(dialog);
    closeDialog(dialog);

    expect(m.send).not.toHaveBeenCalled();
    expect(m.schedule).not.toHaveBeenCalled();
    expect(m.create).not.toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
  });

  describe('schedule and send actions', () => {
    const scheduleButton = () => screen.queryByRole('button', { name: 'Schedule' });

    it.each([EmailJobStatus.SCHEDULED, EmailJobStatus.CANCELLED, EmailJobStatus.COMPLETED])(
      'offers no Schedule for a %s campaign',
      status => {
        m.job = { ...draftJob(EmailJobOverallStatus.COMPLETE), status };
        renderDetail('job1');

        expect(screen.getByDisplayValue('Draft job')).toBeInTheDocument();
        expect(scheduleButton()).toBeNull();
      }
    );

    it('offers Schedule for a draft, even one whose send failed', () => {
      m.job = draftJob(EmailJobOverallStatus.FAILED);
      renderDetail('job1');

      expect(scheduleButton()).toBeInTheDocument();
    });

    it('shows a rejected schedule inline, keeps the form open, and clears the error on cancel', async () => {
      m.schedule.mockRejectedValue(badRequest('Can only schedule jobs in draft status'));
      renderDetail('job1');

      fireEvent.click(scheduleButton()!);
      fireEvent.change(screen.getByLabelText('Send At'), { target: { value: '2099-01-01T10:00' } });
      const [, submit] = screen.getAllByRole('button', { name: 'Schedule' });
      fireEvent.click(submit);

      expect(await screen.findByTestId('email-job-schedule-error')).toHaveTextContent(
        'Can only schedule jobs in draft status'
      );
      expect(screen.getByLabelText('Send At')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByLabelText('Send At')).toBeNull();
      fireEvent.click(scheduleButton()!);
      expect(screen.queryByTestId('email-job-schedule-error')).toBeNull();
    });

    it('drops the Send At form when a refetch moves the job out of draft, keeping the schedule error', async () => {
      m.schedule.mockRejectedValue(badRequest('Can only schedule jobs in draft status'));
      const view = renderDetail('job1');

      fireEvent.click(scheduleButton()!);
      fireEvent.change(screen.getByLabelText('Send At'), { target: { value: '2099-01-01T10:00' } });
      fireEvent.click(screen.getAllByRole('button', { name: 'Schedule' })[1]);
      await screen.findByTestId('email-job-schedule-error');

      m.job = { ...draftJob(), status: EmailJobStatus.SCHEDULED };
      view.rerender(
        <CssVarsProvider theme={appTheme}>
          <EmailJobDetail jobId="job1" onBack={() => {}} />
        </CssVarsProvider>
      );

      expect(screen.queryByLabelText('Send At')).toBeNull();
      expect(scheduleButton()).toBeNull();
      expect(screen.getByTestId('email-job-schedule-error')).toHaveTextContent(
        'Can only schedule jobs in draft status'
      );
    });

    it('shows a failed auto-save before sending as an action error', async () => {
      m.update.mockRejectedValueOnce(badRequest('Template not found'));
      renderDetail('job1');
      await screen.findByRole('button', { name: 'View All 30 Recipients' });

      const [send] = screen
        .getAllByRole('button', { name: /^Send Campaign/ })
        .filter(el => !el.hasAttribute('aria-expanded'));
      fireEvent.click(send);

      expect(await screen.findByTestId('email-job-action-error')).toHaveTextContent('Template not found');
      expect(m.send).not.toHaveBeenCalled();
    });

    it('keeps an action error when a refetch lands after it and moves the job to another status', async () => {
      m.job = { ...draftJob(), status: EmailJobStatus.SCHEDULED };
      m.cancel.mockRejectedValue(badRequest('Job is not scheduled'));
      const view = renderDetail('job1');

      fireEvent.click(screen.getByRole('button', { name: 'Cancel Schedule' }));
      await screen.findByTestId('email-job-action-error');

      m.job = { ...draftJob(), status: EmailJobStatus.CANCELLED };
      view.rerender(
        <CssVarsProvider theme={appTheme}>
          <EmailJobDetail jobId="job1" onBack={() => {}} />
        </CssVarsProvider>
      );

      expect(screen.getByTestId('email-job-action-error')).toHaveTextContent('Job is not scheduled');
    });

    it('shows a rejected send as an action error', async () => {
      m.update.mockResolvedValue({});
      m.send.mockRejectedValue(badRequest('Campaign has no eligible recipients'));
      renderDetail('job1');
      await screen.findByRole('button', { name: 'View All 30 Recipients' });

      // The accordion header shares the "Send Campaign" name, so pick the button that is not a disclosure.
      const [send] = screen
        .getAllByRole('button', { name: /^Send Campaign/ })
        .filter(el => !el.hasAttribute('aria-expanded'));
      fireEvent.click(send);

      expect(await screen.findByTestId('email-job-action-error')).toHaveTextContent(
        'Campaign has no eligible recipients'
      );
    });

    it('shows a rejected schedule cancel as an action error', async () => {
      m.job = { ...draftJob(), status: EmailJobStatus.SCHEDULED };
      m.cancel.mockRejectedValue(badRequest('Job is not scheduled'));
      renderDetail('job1');

      fireEvent.click(screen.getByRole('button', { name: 'Cancel Schedule' }));

      expect(await screen.findByTestId('email-job-action-error')).toHaveTextContent('Job is not scheduled');
    });

    it('shows a failed cancel of pending emails as an action error, even without a server response', async () => {
      m.job = draftJob(EmailJobOverallStatus.SENDING);
      m.cancelPending.mockRejectedValue(new Error('Network Error'));
      renderDetail('job1');

      fireEvent.click(screen.getByRole('button', { name: 'Cancel All Pending' }));

      expect(await screen.findByTestId('email-job-action-error')).toHaveTextContent('Network Error');
    });
  });
});
