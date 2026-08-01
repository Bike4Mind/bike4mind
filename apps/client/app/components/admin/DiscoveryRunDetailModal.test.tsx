import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const mockGet = vi.fn();
const mockPost = vi.fn();
vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: (...a: unknown[]) => mockGet(...a), post: (...a: unknown[]) => mockPost(...a) },
}));

import { DiscoveryRunDetailModal } from './DiscoveryRunDetailModal';
import { AdminTab } from './adminSidebarConfig';
import { useAdminModal } from './useAdminModal';
import { useCreditAnalysisStore } from './CreditAnalysis/store';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

/** The production flag that had no explanation anywhere but a log line. */
const LUNA_FLAG = {
  modelId: 'gpt-5.6-luna',
  kind: 'source-disagreement',
  proposed: { inputPerMTok: 0.2, outputPerMTok: 1.2 },
  current: { inputPerMTok: 1, outputPerMTok: 6 },
  sources: ['models.dev', 'litellm'],
  detail: 'sources disagree beyond 10%: models.dev in 0.2/out 1.2 vs litellm in 1/out 6; applied neither',
};

const EMPTY_CHANGES = {
  added: [],
  promoted: [],
  deprecated: [],
  repriced: [],
  flagged: [],
  operatorConflicts: [],
  plannedRows: 0,
  appendedRows: 0,
  plannedPriceRows: 0,
  appendedPriceRows: 0,
};

const RUN = {
  id: 'run-1',
  startedAt: '2026-07-30T12:00:00.000Z',
  finishedAt: '2026-07-30T12:03:00.000Z',
  trigger: 'cron',
  host: 'hosted',
  status: 'ok',
  mode: 'write' as 'write' | 'report' | undefined,
  passes: 2,
  sources: [
    { name: 'models.dev', ok: true, durationMs: 120, httpStatus: 200, recordCount: 113 },
    { name: 'litellm', ok: false, durationMs: 900, error: 'ETIMEDOUT' },
  ],
  joinCoverage: [{ aggregator: 'models.dev', matched: 84, total: 113 }],
  changes: { ...EMPTY_CHANGES, flagged: ['gpt-5.6-luna'], plannedPriceRows: 1, appendedPriceRows: 1 },
  priceFlags: [LUNA_FLAG],
  priceRows: [],
  priceSkips: [],
  lifecycleTransitions: [],
  catalogDiff: [],
  detailTotals: {} as Record<string, number>,
  unmatchedIds: [],
  droppedRecords: [],
};

type Run = typeof RUN;
const runWith = (over: Partial<Run>): Run => ({ ...RUN, ...over });

const renderModal = (runId: string | null = 'run-1', onClose = vi.fn()) =>
  render(
    <TestWrapper>
      <DiscoveryRunDetailModal runId={runId} onClose={onClose} />
    </TestWrapper>
  );

describe('DiscoveryRunDetailModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue({ data: { run: RUN } });
    useAdminModal.setState({ activeTab: AdminTab.ModelLifecycle });
    useCreditAnalysisStore.setState({ activeTab: 'users', pricingModelId: null });
  });

  it('fetches the chosen run and leads with the price flags', async () => {
    renderModal();

    expect(await screen.findByTestId('discovery-run-price-flags-table')).toBeInTheDocument();
    expect(mockGet).toHaveBeenCalledWith('/api/admin/model-discovery?runId=run-1');
    expect(screen.getByTestId('discovery-run-status-chip')).toHaveTextContent('ok');
    expect(screen.getByTestId('discovery-run-header')).toHaveTextContent('cron on hosted');
  });

  it('renders the whole detail sentence, untruncated: it is the explanation the operator came for', async () => {
    renderModal();

    const detail = await screen.findByTestId('discovery-run-flag-detail-gpt-5.6-luna');
    expect(detail).toHaveTextContent(
      'sources disagree beyond 10%: models.dev in 0.2/out 1.2 vs litellm in 1/out 6; applied neither'
    );
  });

  it('shows the proposed rates against the row in force, and names both sources', async () => {
    renderModal();

    const row = await screen.findByTestId('discovery-run-flag-row-gpt-5.6-luna');
    expect(row).toHaveTextContent('$0.2 in / $1.2 out');
    expect(row).toHaveTextContent('$1 in / $6 out');
    expect(row).toHaveTextContent('models.dev, litellm');
    expect(row).toHaveTextContent('source-disagreement');
  });

  it('renders a 404 as an error rather than a blank modal', async () => {
    // The envelope from server/middlewares/errorHandler.ts: the reason is in
    // `error`, and err.message is the useless axios sentence.
    mockGet.mockRejectedValue({
      message: 'Request failed with status code 404',
      response: { data: { name: 'NotFoundError', error: 'Discovery run not found' } },
    });
    renderModal('gone');

    expect(await screen.findByTestId('discovery-run-error')).toHaveTextContent('Discovery run not found');
    expect(screen.getByTestId('discovery-run-modal')).toBeInTheDocument();
    expect(screen.queryByTestId('discovery-run-price-flags-table')).not.toBeInTheDocument();
  });

  it('shows the reason a 403 gives rather than the axios status sentence', async () => {
    mockGet.mockRejectedValue({
      message: 'Request failed with status code 403',
      response: { data: { name: 'ForbiddenError', error: 'Admin access required' } },
    });
    renderModal('run-1');

    expect(await screen.findByTestId('discovery-run-error')).toHaveTextContent('Admin access required');
  });

  it('falls back to a message-shaped body for endpoints outside that envelope', async () => {
    mockGet.mockRejectedValue({
      message: 'Request failed with status code 503',
      response: { data: { message: 'Discovery is unavailable on this deployment' } },
    });
    renderModal('run-1');

    expect(await screen.findByTestId('discovery-run-error')).toHaveTextContent(
      'Discovery is unavailable on this deployment'
    );
  });

  it('hides every section that has no rows', async () => {
    mockGet.mockResolvedValue({
      data: { run: runWith({ priceFlags: [], changes: EMPTY_CHANGES }) },
    });
    renderModal();

    // Mechanics always renders, so the modal is never blank.
    expect(await screen.findByTestId('discovery-run-sources-table')).toBeInTheDocument();
    expect(screen.queryByTestId('discovery-run-price-flags-table')).not.toBeInTheDocument();
    expect(screen.queryByTestId('discovery-run-price-rows-table')).not.toBeInTheDocument();
    expect(screen.queryByTestId('discovery-run-lifecycle-table')).not.toBeInTheDocument();
    expect(screen.queryByTestId('discovery-run-catalog-table')).not.toBeInTheDocument();
    expect(screen.queryByTestId('discovery-run-skips-toggle')).not.toBeInTheDocument();
    expect(screen.queryByTestId('discovery-run-operator-conflicts')).not.toBeInTheDocument();
  });

  it('calls out planned price rows that never landed, even on a run reporting ok', async () => {
    mockGet.mockResolvedValue({
      data: {
        run: runWith({ mode: 'write', changes: { ...EMPTY_CHANGES, plannedPriceRows: 32, appendedPriceRows: 0 } }),
      },
    });
    renderModal();

    const warning = await screen.findByTestId('discovery-run-write-gap');
    expect(warning).toHaveTextContent('32 price rows planned, 0 appended');
    expect(screen.getByTestId('discovery-run-counters')).toHaveTextContent('price rows 0/32 appended');
  });

  it('says nothing about write gaps when every planned row landed', async () => {
    renderModal();

    await screen.findByTestId('discovery-run-price-flags-table');
    expect(screen.queryByTestId('discovery-run-write-gap')).not.toBeInTheDocument();
  });

  it('reads a report-mode run as a plan that wrote nothing, not as lost writes', async () => {
    // Report mode is the default, and it plans rows and writes none BY DESIGN.
    // Warning here is how the warning stops meaning anything: production has runs
    // recording 32 planned / 0 appended with status ok.
    mockGet.mockResolvedValue({
      data: {
        run: runWith({
          mode: 'report',
          changes: { ...EMPTY_CHANGES, plannedPriceRows: 32, appendedPriceRows: 0 },
          priceRows: [
            {
              modelId: 'gpt-cheap',
              unit: 'per_token',
              inputPerMTok: 0.5,
              outputPerMTok: 1.5,
              effectiveFrom: '2026-07-30T12:00:00.000Z',
              sources: ['openrouter'],
              note: 'discovery:openrouter@2026-07-30',
            },
          ],
        }),
      },
    });
    renderModal();

    expect(await screen.findByTestId('discovery-run-report-mode')).toHaveTextContent('wrote nothing');
    expect(screen.queryByTestId('discovery-run-write-gap')).not.toBeInTheDocument();
    // And the section may not claim a model was repriced on a run that wrote none.
    const modal = screen.getByTestId('discovery-run-modal');
    expect(modal).toHaveTextContent('Price rows planned (1)');
    expect(modal).not.toHaveTextContent('Repriced (1)');
  });

  it('stays silent about the mode on a run document written before the field existed', async () => {
    mockGet.mockResolvedValue({
      data: {
        run: runWith({ mode: undefined, changes: { ...EMPTY_CHANGES, plannedPriceRows: 32, appendedPriceRows: 0 } }),
      },
    });
    renderModal();

    await screen.findByTestId('discovery-run-price-flags-table');
    // Neither claim can be made: an absent mode is not evidence of either one.
    expect(screen.queryByTestId('discovery-run-report-mode')).not.toBeInTheDocument();
    expect(screen.queryByTestId('discovery-run-write-gap')).not.toBeInTheDocument();
  });

  it('says which sections are showing only the first 200 rows of a wider run', async () => {
    mockGet.mockResolvedValue({
      data: {
        run: runWith({
          changes: { ...EMPTY_CHANGES, flagged: ['gpt-5.6-luna'] },
          detailTotals: { priceFlags: 260 },
        }),
      },
    });
    renderModal();

    await screen.findByTestId('discovery-run-price-flags-table');
    // 260 flagged in the header against 1 stored flag: without the marker the
    // missing 259 could include the one price that actually moved.
    expect(screen.getByTestId('discovery-run-modal')).toHaveTextContent('Price flags (first 1 of 260)');
  });

  it('keeps the low-signal not-repriced list collapsed until asked for', async () => {
    mockGet.mockResolvedValue({
      data: { run: runWith({ priceSkips: [{ modelId: 'gpt-quiet', reason: 'unchanged' }] }) },
    });
    renderModal();

    const toggle = await screen.findByTestId('discovery-run-skips-toggle');
    expect(screen.queryByTestId('discovery-run-skips-table')).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(screen.getByTestId('discovery-run-skips-table')).toHaveTextContent('gpt-quiet');
  });

  it('shows operator conflicts as their own work item, not merged into the price flags', async () => {
    mockGet.mockResolvedValue({
      data: {
        run: runWith({
          changes: { ...EMPTY_CHANGES, flagged: ['gpt-5.6-luna'], operatorConflicts: ['gpt-operator-owned'] },
        }),
      },
    });
    renderModal();

    const conflicts = await screen.findByTestId('discovery-run-operator-conflicts');
    expect(conflicts).toHaveTextContent('gpt-operator-owned');
    // The flag means "an operator-owned catalog row exists", nothing about a value
    // diverging and nothing about prices: operatorOwned in the service's
    // CatalogDiffEntry is exactly that one fact.
    expect(conflicts).toHaveTextContent('An operator catalog row exists');
    expect(conflicts).not.toHaveTextContent('different value');
    expect(screen.getByTestId('discovery-run-price-flags-table')).not.toHaveTextContent('gpt-operator-owned');
  });

  it('jumps a flagged model to Model Pricing: admin tab, pricing sub-tab and the model in focus', async () => {
    const onClose = vi.fn();
    renderModal('run-1', onClose);

    const jump = await screen.findByTestId('discovery-run-flag-pricing-gpt-5.6-luna');
    // A Joy Link with an onClick and no href renders an <a> with no href: not
    // focusable, not announced, unreachable by keyboard.
    expect(jump.tagName).toBe('BUTTON');

    fireEvent.click(jump);

    expect(useAdminModal.getState().activeTab).toBe(AdminTab.CreditAnalytics);
    expect(useCreditAnalysisStore.getState().activeTab).toBe('pricing');
    expect(useCreditAnalysisStore.getState().pricingModelId).toBe('gpt-5.6-luna');
    expect(onClose).toHaveBeenCalled();
  });

  it('renders the lifecycle, repriced and catalog sections when the run carries them', async () => {
    mockGet.mockResolvedValue({
      data: {
        run: runWith({
          priceRows: [
            {
              modelId: 'gpt-cheap',
              unit: 'per_token',
              inputPerMTok: 0.5,
              outputPerMTok: 1.5,
              effectiveFrom: '2026-07-30T12:00:00.000Z',
              sources: ['openrouter'],
              note: 'discovery:openrouter@2026-07-30',
            },
          ],
          lifecycleTransitions: [
            {
              modelId: 'gpt-sunset',
              from: 'active',
              to: 'deprecated',
              signal: 'typed',
              deprecationDate: '2026-08-01',
              replacedBy: 'gpt-live',
              autoApplied: false,
            },
          ],
          catalogDiff: [
            {
              modelId: 'gpt-new',
              kind: 'added',
              ownedGroups: ['identity'],
              changedKeys: ['contextWindow'],
              lifecycleStatus: 'active',
              promoted: false,
              blockedBy: ['no-price'],
              operatorOwned: false,
            },
          ],
        }),
      },
    });
    renderModal();

    expect(await screen.findByTestId('discovery-run-price-row-gpt-cheap-0')).toHaveTextContent('$0.5');
    const lifecycle = screen.getByTestId('discovery-run-lifecycle-row-gpt-sunset-0');
    expect(lifecycle).toHaveTextContent('active -> deprecated');
    expect(lifecycle).toHaveTextContent('suggestion');
    const catalog = screen.getByTestId('discovery-run-catalog-row-gpt-new');
    expect(catalog).toHaveTextContent('contextWindow');
    expect(catalog).toHaveTextContent('no-price');
  });

  it('renders two passes of the same model as two rows, with distinct keys and testids', async () => {
    // priceRows and lifecycleTransitions are plain flatMaps across convergence
    // passes (aggregate() in runModelDiscovery.ts collapses every other array), so
    // one modelId+unit twice in one run is legitimate.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const row = (inputPerMTok: number) => ({
      modelId: 'gpt-twice',
      unit: 'per_token',
      inputPerMTok,
      outputPerMTok: 4,
      effectiveFrom: '2026-07-30T12:00:00.000Z',
      sources: ['openai'],
      note: 'discovery:openai@2026-07-30',
    });
    mockGet.mockResolvedValue({
      data: {
        run: runWith({
          priceRows: [row(1), row(2)],
          lifecycleTransitions: [
            { modelId: 'gpt-sunset', to: 'deprecated', signal: 'absence', autoApplied: false },
            { modelId: 'gpt-sunset', to: 'retired', signal: 'typed', autoApplied: true },
          ],
        }),
      },
    });
    renderModal();

    expect(await screen.findByTestId('discovery-run-price-row-gpt-twice-0')).toHaveTextContent('$1');
    expect(screen.getByTestId('discovery-run-price-row-gpt-twice-1')).toHaveTextContent('$2');
    expect(screen.getByTestId('discovery-run-lifecycle-row-gpt-sunset-0')).toHaveTextContent('deprecated');
    expect(screen.getByTestId('discovery-run-lifecycle-row-gpt-sunset-1')).toHaveTextContent('retired');
    expect(consoleError.mock.calls.flat().join(' ')).not.toContain('same key');
    consoleError.mockRestore();
  });

  it('fetches nothing until a run is chosen', () => {
    renderModal(null);

    expect(mockGet).not.toHaveBeenCalled();
    expect(screen.queryByTestId('discovery-run-modal')).not.toBeInTheDocument();
  });

  it('ignores a slow response for a run the operator already navigated away from', async () => {
    let resolveSlow: (value: unknown) => void = () => {};
    mockGet.mockReturnValueOnce(new Promise(resolve => (resolveSlow = resolve)));
    const { rerender } = renderModal('run-slow');

    mockGet.mockResolvedValueOnce({ data: { run: runWith({ id: 'run-2', trigger: 'manual' }) } });
    rerender(
      <TestWrapper>
        <DiscoveryRunDetailModal runId="run-2" onClose={vi.fn()} />
      </TestWrapper>
    );
    await waitFor(() => expect(screen.getByTestId('discovery-run-header')).toHaveTextContent('manual on hosted'));

    resolveSlow({ data: { run: runWith({ id: 'run-slow', trigger: 'stale' }) } });
    await waitFor(() => expect(screen.getByTestId('discovery-run-header')).not.toHaveTextContent('stale'));
  });
});
