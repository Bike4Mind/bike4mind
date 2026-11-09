import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  updateSettings: vi.fn(),
  settings: {} as Record<string, unknown>,
}));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: mocks.get, post: mocks.post } }));
vi.mock('@client/app/hooks/data/settings', () => ({
  useGetSettingsValue: (key: string) => mocks.settings[key],
  useUpdateSettings: () => ({ mutate: mocks.updateSettings, isPending: false, error: null }),
}));
vi.mock('@client/app/hooks/data/useModelInfo', () => ({ useModelInfo: () => ({ data: [] }) }));

import ContextInspectorTab from './ContextInspectorTab';

const TELEMETRY_URL = '/api/admin/context-telemetry?';
const HEALTH_URL = '/api/admin/context-telemetry/integration-status';
const DRY_RUN_URL = '/api/admin/context-telemetry/dry-run-results?limit=10';

const noAnomalies = {
  contextOverflow: false,
  highUtilization: false,
  criticalUtilization: false,
  highTruncation: false,
  criticalTruncation: false,
  toolFailureSpike: false,
  toolTimeout: false,
  subagentTimeout: false,
  slowTotalResponse: false,
  slowFirstToken: false,
};

const entry = (id: string, over: { severity?: string; primaryAnomaly?: string; slow?: boolean } = {}) => ({
  id,
  timestamp: '2026-11-01T10:00:00.000Z',
  telemetry: {
    model: { modelId: `model-${id}`, provider: 'anthropic', fallbackUsed: id === 'e1' },
    contextWindow: { inputTokens: 12000, utilizationPercentage: 42.5 },
    performance: { totalResponseTimeMs: 3200 },
    anomalies: {
      ...noAnomalies,
      slowTotalResponse: over.slow ?? true,
      anomalyScore: 40,
      severity: over.severity ?? 'high',
      primaryAnomaly: over.primaryAnomaly ?? 'slow_response',
    },
    tools: [
      { toolName: 'web_search', invocationCount: 4, failureCount: 2, totalDurationMs: 800, lastError: 'timeout' },
    ],
    subagents: [],
  },
});

const stats = {
  totalEntries: 134,
  avgAnomalyScore: 12,
  avgUtilization: 0,
  avgResponseTimeMs: 3200,
  providers: ['anthropic', 'openai'],
  models: [],
  severityDistribution: { critical: 1, high: 2, medium: 0, low: 5 },
};

const telemetry = (over: Record<string, unknown> = {}) => ({
  entries: [entry('e1'), entry('e2', { severity: 'low', primaryAnomaly: 'none', slow: false })],
  total: 2,
  offset: 0,
  limit: 20,
  stats,
  ...over,
});

const health = {
  overall: 'degraded',
  checks: [
    { name: 'GitHub token', status: 'ok', message: 'Token found' },
    { name: 'Slack channel', status: 'warning', message: 'No channel set' },
    { name: 'LLM', status: 'error', message: 'Model missing' },
  ],
  github: true,
  slack: false,
  llm: false,
};

let telemetryResponse: () => Promise<{ data: unknown }>;
const routeGet = (url: string) => {
  if (url.startsWith(TELEMETRY_URL)) return telemetryResponse();
  if (url === HEALTH_URL) return Promise.resolve({ data: health });
  if (url === DRY_RUN_URL) return Promise.resolve({ data: dryRunResults });
  if (url === '/api/admin/slack-workspaces') return Promise.resolve({ data: { workspaces: [] } });
  return Promise.reject(new Error(`unexpected GET ${url}`));
};

const dryRunResults = {
  total: 1,
  results: [
    {
      _id: 'run1',
      timestamp: '2026-11-01T10:00:00.000Z',
      source: 'test',
      telemetrySummary: {
        anomalyScore: 70,
        severity: 'critical',
        primaryAnomaly: 'context_overflow',
        modelId: 'claude-test',
        provider: 'anthropic',
      },
      action: {
        wouldCreateIssue: true,
        issueTitle: 'Context overflow on claude-test',
        priority: 'P0',
        labels: [],
        isRegression: false,
        isDuplicate: false,
        wouldSendSlackAlert: true,
      },
      fingerprint: 'f',
      semanticFingerprint: 's',
      expiresAt: '2026-11-08T10:00:00.000Z',
    },
  ],
};

const appTheme = extendTheme({ ...getThemeConfig() });
const renderTab = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={appTheme}>
        <ContextInspectorTab />
      </CssVarsProvider>
    </QueryClientProvider>
  );
};

const telemetryCalls = () => mocks.get.mock.calls.map(([url]) => url).filter(url => url.startsWith(TELEMETRY_URL));
const entriesCard = () => screen.getByTestId('context-inspector-entries-card');
const tiles = () =>
  within(screen.getByTestId('admin-stat-strip'))
    .getAllByTestId('admin-stat-tile')
    .map(tile => tile.textContent);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings = { EnableContextTelemetry: true, contextTelemetryAlerts: undefined };
  telemetryResponse = () => Promise.resolve({ data: telemetry() });
  mocks.get.mockImplementation(routeGet);
});

describe('ContextInspectorTab page frame', () => {
  it('opens with the Context inspector header, the telemetry toggle and Refresh in its actions', async () => {
    renderTab();
    await screen.findByTestId('context-inspector-entry-e1');
    const root = screen.getByTestId('context-inspector-root');
    const header = screen.getByTestId('admin-page-header');

    expect(root.firstElementChild).toBe(header);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(within(header).getByRole('heading', { level: 1 })).toHaveTextContent(/^Context inspector$/);
    expect(within(header).getByTestId('context-inspector-telemetry-toggle')).toBeChecked();
    expect(within(header).getByTestId('context-inspector-telemetry-chip')).toHaveAttribute('data-tone', 'good');
    expect(within(header).getByTestId('context-inspector-refresh-btn')).toHaveTextContent('Refresh');
  });

  it('uses plain section cards, one level deep, with no colored outlines anywhere on the page', async () => {
    const { container } = renderTab();
    await screen.findByTestId('context-inspector-entry-e1');

    expect(container.querySelector('.MuiCard-root')).toBeNull();
    expect(container.querySelector('.MuiChip-variantOutlined, .MuiAlert-variantOutlined')).toBeNull();
    const cards = Array.from(container.querySelectorAll<HTMLElement>('section.MuiSheet-root'));
    expect(cards.map(card => card.getAttribute('data-testid'))).toEqual([
      'context-inspector-settings-card',
      'context-inspector-entries-card',
    ]);
    for (const card of cards) expect(card.parentElement?.closest('.MuiSheet-root, .MuiCard-root')).toBeNull();
    expect(within(cards[0]).getByRole('heading', { level: 3 })).toHaveTextContent(/^Alerts and integrations$/);
    expect(cards[0].querySelector('h3 svg')).toBeNull();
  });

  it('warns with a toned banner, right under the header, while collection is off', async () => {
    mocks.settings.EnableContextTelemetry = false;
    renderTab();
    await screen.findByTestId('context-inspector-entry-e1');
    const banner = screen.getByTestId('context-inspector-disabled-banner');
    expect(screen.getByTestId('context-inspector-root').children[1]).toBe(banner);
    expect(banner).toHaveClass('MuiAlert-colorWarning');
    expect(screen.getByTestId('context-inspector-telemetry-chip')).toHaveAttribute('data-tone', 'neutral');
  });
});

describe('ContextInspectorTab numbers and status', () => {
  it('puts the summary in one stat strip, with a 0% average in plain ink', async () => {
    renderTab();
    await screen.findByTestId('context-inspector-entry-e1');
    expect(tiles()).toEqual([
      'Total entries134',
      'Avg anomaly score12',
      'Avg utilization0%',
      'Avg response time3.2s',
      'SeverityCritical: 1High: 2Medium: 0Low: 5',
    ]);
    const utilization = within(screen.getByTestId('admin-stat-strip')).getAllByTestId('admin-stat-tile')[2];
    expect(utilization.querySelector('[data-tone]')).toBeNull();
    expect(within(utilization).getByText('0%')).toHaveStyle({ color: 'var(--joy-palette-admin-ink)' });

    const tone = (severity: string) =>
      screen.getByTestId(`context-inspector-severity-${severity}`).getAttribute('data-tone');
    expect(['critical', 'high', 'medium', 'low'].map(tone)).toEqual(['bad', 'bad', 'neutral', 'neutral']);
  });

  it('marks a high average with a warn chip beside an ink number', async () => {
    telemetryResponse = () =>
      Promise.resolve({ data: telemetry({ stats: { ...stats, avgAnomalyScore: 34, avgUtilization: 92 } }) });
    renderTab();
    await screen.findByTestId('context-inspector-entry-e1');
    const [, score, utilization] = within(screen.getByTestId('admin-stat-strip')).getAllByTestId('admin-stat-tile');
    for (const tile of [score, utilization]) {
      expect(within(tile).getByTestId('admin-status-chip')).toHaveAttribute('data-tone', 'warn');
      expect(within(tile).getByTestId('admin-status-chip')).toHaveTextContent('High');
    }
    expect(within(score).getByText('34')).toHaveStyle({ color: 'var(--joy-palette-admin-ink)' });
  });

  it('lists entries as hairline rows of one card, with status only in chips', async () => {
    renderTab();
    const first = await screen.findByTestId('context-inspector-entry-e1');
    const second = screen.getByTestId('context-inspector-entry-e2');
    expect(first.parentElement).toBe(second.parentElement);
    expect(entriesCard()).toContainElement(first);
    expect(within(entriesCard()).getByTestId('context-inspector-entries-count')).toHaveTextContent(
      'Showing 2 of 2 entries'
    );

    // The row's own chips, not the ones inside its tools table.
    const chips = (row: HTMLElement) =>
      within(row)
        .getAllByTestId(/^(admin-status-chip|context-inspector-(severity|anomaly)-chip)$/)
        .filter(chip => !chip.closest('table'))
        .map(chip => `${chip.textContent}:${chip.getAttribute('data-tone')}`);
    expect(chips(first)).toEqual(['High severity:bad', 'Fallback:warn', 'Slow response:warn']);
    expect(chips(second)).toEqual(['Benign:neutral', 'No anomalies:good']);
    expect(first.querySelector('.MuiLinearProgress-root')).toBeNull();
    expect(within(first).getByTestId('admin-inline-bar')).toBeInTheDocument();
  });

  it('puts an entry tools in a DataTable that scrolls inside its frame below its min width', async () => {
    renderTab();
    await screen.findByTestId('context-inspector-entry-e1');
    const table = screen.getByTestId('context-inspector-tools-table-e1');
    expect(table).toHaveStyle({ minWidth: '40rem' });
    expect(table.closest('[role="region"]')).toHaveStyle({ overflowX: 'auto' });
    const row = within(table).getByTestId('admin-table-row-web_search');
    expect(within(row).getByTestId('admin-status-chip')).toHaveAttribute('data-tone', 'bad');
    expect(row).toHaveTextContent('web_search42200ms');
  });

  it('shows integration health as status chips', async () => {
    renderTab();
    await screen.findByTestId('context-inspector-entry-e1');
    const card = screen.getByTestId('context-inspector-settings-card');
    expect(await within(card).findByTestId('context-inspector-health-chip')).toHaveAttribute('data-tone', 'warn');
    const checks = within(card)
      .getAllByTestId('context-inspector-health-check')
      .map(check => `${check.textContent}:${within(check).getByTestId('admin-status-chip').getAttribute('data-tone')}`);
    expect(checks).toEqual([
      'GitHub tokenOKToken found:good',
      'Slack channelWarningNo channel set:warn',
      'LLMErrorModel missing:bad',
    ]);
  });
});

describe('ContextInspectorTab requests and states', () => {
  it('requests the first page with the default filters, refreshes from the header and filters with chips', async () => {
    renderTab();
    await screen.findByTestId('context-inspector-entry-e1');
    expect(telemetryCalls()).toEqual(['/api/admin/context-telemetry?limit=20']);

    fireEvent.click(screen.getByTestId('context-inspector-refresh-btn'));
    await waitFor(() => expect(telemetryCalls()).toHaveLength(2));

    fireEvent.click(screen.getByTestId('admin-filter-severity'));
    fireEvent.click(screen.getByTestId('admin-filter-severity-critical'));
    await waitFor(() =>
      expect(telemetryCalls().at(-1)).toBe('/api/admin/context-telemetry?severity=critical&limit=20')
    );

    fireEvent.click(screen.getByTestId('admin-filter-min-score'));
    fireEvent.click(screen.getByTestId('admin-filter-min-score-0'));
    await waitFor(() =>
      expect(telemetryCalls().at(-1)).toBe('/api/admin/context-telemetry?minAnomalyScore=0&severity=critical&limit=20')
    );
  });

  it('shows a loading state inside the entries card on the first load', async () => {
    telemetryResponse = () => new Promise(() => undefined);
    renderTab();
    expect(await within(entriesCard()).findByTestId('context-inspector-loading')).toHaveTextContent(
      'Loading telemetry'
    );
  });

  it('shows an error state with a retry inside the entries card when the load fails', async () => {
    telemetryResponse = () => Promise.reject(new Error('boom'));
    renderTab();
    const error = await within(entriesCard()).findByTestId('admin-error-state');
    expect(error).toHaveTextContent('Could not load telemetry: boom');

    telemetryResponse = () => Promise.resolve({ data: telemetry() });
    fireEvent.click(within(error).getByTestId('admin-error-retry-btn'));
    expect(await screen.findByTestId('context-inspector-entry-e1')).toBeInTheDocument();
  });

  it('shows an empty state, and offers to clear filters that match nothing', async () => {
    telemetryResponse = () => Promise.resolve({ data: telemetry({ entries: [], total: 0 }) });
    renderTab();
    const empty = await within(entriesCard()).findByTestId('admin-empty-state');
    expect(empty).toHaveTextContent('No telemetry entries yet');
    expect(within(empty).queryByTestId('context-inspector-clear-filters-btn')).toBeNull();

    fireEvent.click(screen.getByTestId('admin-filter-severity'));
    fireEvent.click(screen.getByTestId('admin-filter-severity-low'));
    await within(entriesCard()).findByText('No entries match these filters');
    expect(telemetryCalls().at(-1)).toBe('/api/admin/context-telemetry?severity=low&limit=20');
    fireEvent.click(within(entriesCard()).getByTestId('context-inspector-clear-filters-btn'));
    expect(await within(entriesCard()).findByText('No telemetry entries yet')).toBeInTheDocument();
    expect(screen.getByTestId('admin-filter-severity')).toHaveTextContent(/^Severity$/);
  });
});

describe('ContextInspectorTab dialogs', () => {
  it('analyzes an entry in an admin dialog with sectioned, icon-free findings', async () => {
    mocks.post.mockResolvedValue({
      data: {
        id: 'e1',
        analysis: {
          summary: 'Responses are slow.',
          findings: ['Slow first token'],
          recommendations: ['Use a faster model'],
          severity: 'medium',
          estimatedImpact: 'Users wait longer.',
          recommendedAction: 'investigate_soon',
        },
        historicalBaselines: {
          avgResponseTimeMs: 2000,
          p95ResponseTimeMs: 5000,
          avgUtilization: 30,
          utilizationRange: { low: 10, high: 60 },
          sampleCount: 40,
          windowDays: 7,
        },
        analysisSource: 'rule-based',
      },
    });
    renderTab();
    fireEvent.click(await screen.findByTestId('context-inspector-analyze-e1'));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/admin/context-telemetry/e1/analyze'));

    const dialog = await screen.findByTestId('context-inspector-analysis-dialog');
    expect(within(dialog).getByRole('heading', { level: 2 })).toHaveTextContent('Anomaly analysis');
    expect(await within(dialog).findByTestId('context-inspector-analysis-severity')).toHaveAttribute(
      'data-tone',
      'warn'
    );
    expect(within(dialog).getByTestId('context-inspector-analysis-severity')).toHaveTextContent('Medium severity');
    expect(within(dialog).getByTestId('context-inspector-analysis-action')).toHaveTextContent('Investigate soon');
    expect(within(dialog).getByTestId('context-inspector-analysis-action')).toHaveAttribute('data-tone', 'warn');
    expect(within(dialog).getByTestId('context-inspector-analysis-summary')).toHaveClass('MuiAlert-colorWarning');

    const titles = within(dialog)
      .getAllByRole('heading', { level: 3 })
      .map(heading => heading.textContent);
    expect(titles).toEqual(['Findings', 'Recommendations', 'Historical baselines']);
    expect(dialog.querySelector('h3 svg, li svg')).toBeNull();
    expect(within(dialog).getByTestId('context-inspector-baselines')).toHaveTextContent(
      'Normal utilization10% \u2013 60% (mean \u00b1 1\u03c3)'
    );
  });

  it('creates a GitHub issue through an admin dialog, then confirms it', async () => {
    mocks.settings.contextTelemetryAlerts = { enabled: true, githubOwner: 'acme', githubRepo: 'widgets' };
    mocks.post.mockResolvedValue({
      data: { success: true, issue: { number: 7, url: 'https://example.com/issues/7' }, telemetryId: 'e1' },
    });
    renderTab();
    const createBtn = await screen.findByTestId('context-inspector-create-issue-e1');
    await waitFor(() => expect(createBtn).not.toBeDisabled());
    fireEvent.click(createBtn);

    const dialog = screen.getByTestId('context-inspector-create-issue-dialog');
    expect(within(dialog).getByRole('heading', { level: 2 })).toHaveTextContent('Create GitHub issue');
    fireEvent.click(within(dialog).getByTestId('context-inspector-create-issue-submit-btn'));
    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith('/api/admin/context-telemetry/e1/create-issue', {
        repository: 'acme/widgets',
        additionalContext: undefined,
      })
    );

    const created = await screen.findByTestId('context-inspector-issue-created-dialog');
    expect(within(created).getByRole('heading', { level: 2 })).toHaveTextContent('Issue created');
    expect(within(created).getByTestId('context-inspector-issue-link')).toHaveAttribute(
      'href',
      'https://example.com/issues/7'
    );
  });

  it('lists dry run results in a DataTable with priority and outcome chips', async () => {
    mocks.settings.contextTelemetryAlerts = { enabled: true, dryRun: true };
    renderTab();
    const panel = await screen.findByTestId('dry-run-results-panel');
    const row = await within(panel).findByTestId('dry-run-result-card');
    expect(mocks.get).toHaveBeenCalledWith(DRY_RUN_URL);
    expect(within(panel).getByTestId('dry-run-results-table')).toHaveStyle({ minWidth: '48rem' });
    expect(within(row).getByTestId('dry-run-priority-chip')).toHaveAttribute('data-tone', 'bad');
    expect(within(row).getByTestId('dry-run-source-chip')).toHaveAttribute('data-tone', 'neutral');
    expect(within(row).getByTestId('dry-run-create-issue-chip')).toHaveAttribute('data-tone', 'info');
    expect(row).toHaveTextContent('Title: Context overflow on claude-test');
  });
});
