import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
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
  useCancelEmailJob: () => mutation(vi.fn()),
  useCancelPendingEmails: () => mutation(vi.fn()),
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

  // jsdom's getComputedStyle ignores @media rules, so read the declarations emitted for the element's
  // classes inside the `min-width` query for a breakpoint (0px is the phone-first base, 900px is md).
  const declared = (testId: string, minWidth: string) => {
    const classes = Array.from(screen.getByTestId(testId).classList);
    const found: Record<string, string> = {};
    for (const sheet of Array.from(document.styleSheets)) {
      for (const rule of Array.from(sheet.cssRules)) {
        if (!(rule instanceof CSSMediaRule) || !rule.conditionText.replace(/\s/g, '').includes(`(min-width:${minWidth})`)) {
          continue;
        }
        for (const inner of Array.from(rule.cssRules)) {
          if (!(inner instanceof CSSStyleRule) || !classes.some(c => inner.selectorText === `.${c}`)) continue;
          for (const name of Array.from(inner.style)) found[name] = inner.style.getPropertyValue(name);
        }
      }
    }
    return found;
  };

  it('stacks the form and preview columns on a narrow window and keeps the 50/50 split from md up', () => {
    renderDetail('job1');

    expect(declared('email-job-detail-columns', '0px')['flex-direction']).toBe('column');
    expect(declared('email-job-detail-form-column', '0px')).toMatchObject({ width: '100%' });
    expect(declared('email-job-detail-preview-column', '0px')).toMatchObject({ width: '100%' });

    expect(getComputedStyle(screen.getByTestId('email-job-detail-form-column')).minWidth).toBe('0px');
    expect(getComputedStyle(screen.getByTestId('email-job-detail-preview-column')).minWidth).toBe('0px');

    expect(declared('email-job-detail-columns', '900px')['flex-direction']).toBe('row');
    expect(declared('email-job-detail-form-column', '900px')).toMatchObject({ width: '50%' });
    expect(declared('email-job-detail-preview-column', '900px')).toMatchObject({ width: '50%' });
  });

  it('lets the preview header wrap so the recipient select cannot force a sideways scroll', () => {
    renderDetail('job1');

    expect(getComputedStyle(screen.getByTestId('email-job-detail-preview-header')).flexWrap).toBe('wrap');
  });
});
