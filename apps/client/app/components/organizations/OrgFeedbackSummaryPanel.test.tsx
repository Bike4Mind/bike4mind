import { getThemeConfig } from '@client/app/utils/themes';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  useOrgFeedbackReport: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
  /** The websocket callback the panel registers, so a test can fire a real completion frame. */
  handlers: [] as ((data: unknown) => void)[],
}));

vi.mock('@client/app/hooks/data/orgFeedbackReport', () => ({ useOrgFeedbackReport: h.useOrgFeedbackReport }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: h.get, post: h.post } }));
vi.mock('@client/app/contexts/WebsocketContext', () => ({
  useWebsocket: () => ({
    subscribeToAction: (_action: string, cb: (data: unknown) => void) => {
      h.handlers.push(cb);
      return () => {
        h.handlers = h.handlers.filter(entry => entry !== cb);
      };
    },
  }),
}));

import OrgFeedbackSummaryPanel from './OrgFeedbackSummaryPanel';

const appTheme = extendTheme({ ...getThemeConfig() });
const ORG_ID = 'org1';
const RANGE = { from: '2026-01-01', to: '2026-01-31' };

const ARTIFACT = {
  summaryJobId: 'sum-1',
  organizationId: ORG_ID,
  range: { from: '2026-01-01T00:00:00.000Z', to: '2026-01-31T23:59:59.999Z' },
  generatedAt: '2026-02-01T00:00:00.000Z',
  model: 'claude-haiku',
  summary: 'Reports were steady, with bugs leading.',
  counts: {
    totals: { count: 4 },
    byDay: [],
    bySubject: [],
    byType: [],
    byStatus: [],
    byTag: [],
  },
};

const renderPanel = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <CssVarsProvider theme={appTheme}>
        <OrgFeedbackSummaryPanel organizationId={ORG_ID} range={RANGE} />
      </CssVarsProvider>
    </QueryClientProvider>
  );

beforeEach(() => {
  vi.clearAllMocks();
  h.handlers = [];
  h.useOrgFeedbackReport.mockReturnValue({ data: { totals: { count: 4 } } });
  h.get.mockResolvedValue({ data: { status: 'none' } });
});

describe('OrgFeedbackSummaryPanel', () => {
  it('offers to generate when nothing has been asked for yet', async () => {
    renderPanel();

    await screen.findByTestId('feedback-summary-idle');
    await waitFor(() => expect(screen.getByTestId('feedback-summary-generate-button')).not.toBeDisabled());
  });

  it('shows the spinner while the worker is running', async () => {
    h.get.mockResolvedValue({ data: { status: 'processing', summaryJobId: 'sum-1' } });

    renderPanel();

    await screen.findByTestId('feedback-summary-pending-spinner');
    expect(screen.getByTestId('feedback-summary-generate-button')).toBeDisabled();
  });

  it('surfaces the failure and offers a retry', async () => {
    h.get.mockResolvedValue({ data: { status: 'failed', summaryJobId: 'sum-1', errorMessage: 'bedrock unavailable' } });

    renderPanel();

    expect(await screen.findByTestId('feedback-summary-error-alert')).toHaveTextContent('bedrock unavailable');
    expect(screen.getByTestId('feedback-summary-generate-button')).not.toBeDisabled();
  });

  it('refuses to summarize a window with no feedback in it', async () => {
    h.useOrgFeedbackReport.mockReturnValue({ data: { totals: { count: 0 } } });

    renderPanel();

    await screen.findByTestId('feedback-summary-empty-state');
    expect(screen.getByTestId('feedback-summary-generate-button')).toBeDisabled();
  });

  it('flips from pending to the written summary when the completion frame arrives', async () => {
    h.get.mockResolvedValue({ data: { status: 'processing', summaryJobId: 'sum-1' } });

    renderPanel();
    await screen.findByTestId('feedback-summary-pending-spinner');

    h.get.mockResolvedValue({ data: { status: 'completed', summaryJobId: 'sum-1', artifact: ARTIFACT } });
    expect(h.handlers).toHaveLength(1);
    h.handlers[0]({
      action: 'org_feedback_summary_progress',
      organizationId: ORG_ID,
      summaryJobId: 'sum-1',
      status: 'completed',
      progress: 100,
    });

    expect(await screen.findByTestId('feedback-summary-result-text')).toHaveTextContent(
      'Reports were steady, with bugs leading.'
    );
  });

  it('renders the summary as markdown instead of printing the raw syntax', async () => {
    h.get.mockResolvedValue({
      data: {
        status: 'completed',
        summaryJobId: 'sum-1',
        artifact: { ...ARTIFACT, summary: '# Feedback Summary\n\n## Volume and Trend\n\nSteady week.' },
      },
    });

    renderPanel();

    const result = await screen.findByTestId('feedback-summary-result-text');
    expect(result.querySelector('h2')).toHaveTextContent('Volume and Trend');
    expect(result.textContent).not.toContain('##');
  });

  describe('stored by-tag counts', () => {
    const renderCompleted = (counts: Partial<typeof ARTIFACT.counts> & { byTagTruncated?: boolean }) => {
      h.get.mockResolvedValue({
        data: {
          status: 'completed',
          summaryJobId: 'sum-1',
          artifact: { ...ARTIFACT, counts: { ...ARTIFACT.counts, ...counts } },
        },
      });
      renderPanel();
      return screen.findByTestId('feedback-summary-by-tag');
    };
    const TWO_TAGS = [
      { key: 'billing', count: 3 },
      { key: 'login', count: 1 },
    ];

    it('renders the stored rows as plain, non-drillable rows', async () => {
      const table = await renderCompleted({ byTag: TWO_TAGS, byTagTruncated: false });

      expect(table).toHaveTextContent('billing3');
      expect(table).toHaveTextContent('login1');
      expect(screen.queryByTestId('feedback-summary-by-tag-row-billing')).toBeNull();
    });

    it('captions a truncated cut with the stored row count', async () => {
      await renderCompleted({ byTag: TWO_TAGS, byTagTruncated: true });

      expect(screen.getByTestId('feedback-summary-by-tag-caption')).toHaveTextContent(
        'Showing the top 2 tags by count; the rest were not included in this summary.'
      );
    });

    it('leaves the caption off when nothing was cut', async () => {
      await renderCompleted({ byTag: TWO_TAGS, byTagTruncated: false });

      expect(screen.queryByTestId('feedback-summary-by-tag-caption')).not.toBeInTheDocument();
    });

    it('leaves the caption off for an artifact written before the flag existed', async () => {
      expect(await renderCompleted({ byTag: TWO_TAGS })).toHaveTextContent('billing3');
      expect(screen.queryByTestId('feedback-summary-by-tag-caption')).not.toBeInTheDocument();
    });

    it('says None when the window had no tagged rows', async () => {
      expect(await renderCompleted({ byTag: [], byTagTruncated: false })).toHaveTextContent('None');
    });
  });

  it('ignores a frame for a different organization', async () => {
    h.get.mockResolvedValue({ data: { status: 'processing', summaryJobId: 'sum-1' } });

    renderPanel();
    await screen.findByTestId('feedback-summary-pending-spinner');
    h.get.mockClear();

    h.handlers[0]({
      action: 'org_feedback_summary_progress',
      organizationId: 'other-org',
      summaryJobId: 'x',
      status: 'completed',
      progress: 100,
    });

    await waitFor(() => expect(screen.getByTestId('feedback-summary-pending-spinner')).toBeInTheDocument());
    expect(h.get).not.toHaveBeenCalled();
  });
});
