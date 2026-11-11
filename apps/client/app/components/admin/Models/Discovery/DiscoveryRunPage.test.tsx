import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AdminModelRow } from '@bike4mind/common';
import {
  EMPTY_CHANGES,
  FULL_ADMIN,
  LUNA_FLAG,
  RUN,
  adminRow,
  apiError,
  makeWrapper,
  modelList,
  newQueryClient,
  runWith,
} from './__tests__/discoveryTestKit';
import { ADMIN_SETTINGS_SEARCH_PARAM, ADMIN_SETTINGS_TAB_SLUG } from '../../adminTabParams';
import type { DiscoveryRun, RunPriceRow } from './discoveryApi';

const m = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  currentUser: { id: 'admin-1', isAdmin: true } as Record<string, unknown>,
  nav: { openModel: vi.fn(), openRun: vi.fn(), openSection: vi.fn(), openPrices: vi.fn() },
  navigate: vi.fn(),
}));

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: (...a: unknown[]) => m.get(...a), post: (...a: unknown[]) => m.post(...a) },
}));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: m.currentUser }) }));
vi.mock('../modelsNavigation', () => ({ useModelsNavigation: () => m.nav }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => m.navigate }));

import { DiscoveryRunPage } from './DiscoveryRunPage';
import { useRunNowStore } from './runDiscoveryNow';

let queryClient = newQueryClient();
let run: DiscoveryRun | Error | ReturnType<typeof apiError> = RUN;
let rows: AdminModelRow[] = [];
let modelsError: ReturnType<typeof apiError> | null = null;
let modelsTotal: number | null = null;

const runGets = () => m.get.mock.calls.filter(([url, config]) => url === '/api/admin/model-discovery' && config).length;

const renderPage = (runId = 'run-1') =>
  render(<DiscoveryRunPage runId={runId} />, { wrapper: makeWrapper(queryClient) });

/** Waits for the run and the model index, so decisions have settled. */
const renderLoaded = async (runId = 'run-1') => {
  const view = renderPage(runId);
  await screen.findByTestId('discovery-run-summary');
  await waitFor(() => expect(screen.getByTestId('discovery-run-decisions')).not.toHaveTextContent('Loading'));
  return view;
};

const openDetails = () => fireEvent.click(screen.getByTestId('discovery-run-details-toggle'));

const priceRow = (modelId: string, source: string, inputPerMTok = 3): RunPriceRow => ({
  modelId,
  unit: 'per_token',
  inputPerMTok,
  outputPerMTok: 15,
  effectiveFrom: '2026-07-30T12:00:00.000Z',
  sources: [source],
  note: `discovery:${source}@2026-07-30`,
});

type Reason = AdminModelRow['reasons'][number];

const needsReview = (id: string, code: Reason['code'], message: string, fixAction?: Reason['fixAction']) =>
  adminRow(id, {
    name: `Model ${id}`,
    status: 'needs-review',
    reasons: [{ code, message, ...(fixAction ? { fixAction } : {}) }],
  });

beforeEach(() => {
  vi.clearAllMocks();
  queryClient = newQueryClient();
  m.currentUser = FULL_ADMIN;
  run = RUN;
  rows = [adminRow('gpt-5.6-luna', { name: 'GPT 5.6 Luna' })];
  modelsError = null;
  modelsTotal = null;
  m.get.mockImplementation(async (url: string, config?: { params?: { runId?: string } }) => {
    if (url === '/api/admin/model-discovery' && config?.params?.runId) {
      if (run instanceof Error || 'response' in run) throw run;
      return { data: { run } };
    }
    if (url === '/api/admin/models') {
      if (modelsError) throw modelsError;
      return { data: modelsTotal === null ? modelList(rows) : { ...modelList(rows), total: modelsTotal } };
    }
    throw new Error(`unexpected GET ${url}`);
  });
});

describe('DiscoveryRunPage frame', () => {
  it('fetches the chosen run and leads with a sentence summary', async () => {
    await renderLoaded();

    expect(m.get).toHaveBeenCalledWith('/api/admin/model-discovery', { params: { runId: 'run-1' } });
    expect(screen.getByTestId('discovery-run-result')).toHaveTextContent('Finished');
    expect(screen.getByTestId('discovery-run-summary')).toHaveTextContent('1 price needs review. 1 source failed.');
    expect(screen.getByTestId('discovery-run-header')).toHaveTextContent('Scheduled run on hosted, started');
  });

  it('links back through the breadcrumb to Models and Discovery', async () => {
    await renderLoaded();

    fireEvent.click(screen.getByTestId('discovery-run-breadcrumb-models'));
    expect(m.nav.openSection).toHaveBeenCalledWith('list');
    fireEvent.click(screen.getByTestId('discovery-run-breadcrumb-discovery'));
    expect(m.nav.openSection).toHaveBeenCalledWith('discovery');
  });

  it('says a running run is still running', async () => {
    run = runWith({ finishedAt: null });
    await renderLoaded();

    expect(screen.getByTestId('discovery-run-result')).toHaveTextContent('Running');
    expect(screen.getByTestId('discovery-run-header')).toHaveTextContent('still running');
  });

  it('shows an expired run as expired, with a way back, and does not retry the 404', async () => {
    run = apiError(404, { error: 'Discovery run not found' });
    renderPage('run-gone');

    const expired = await screen.findByTestId('discovery-run-expired');
    expect(expired).toHaveTextContent('This run has expired. Runs are kept for 90 days.');
    fireEvent.click(screen.getByTestId('discovery-run-back-btn'));
    expect(m.nav.openSection).toHaveBeenCalledWith('discovery');
    expect(runGets()).toBe(1);
  });

  it('shows the reason a 403 gives rather than the axios status sentence', async () => {
    run = apiError(403, { error: 'Missing permission: support:read' });
    renderPage();

    expect(await screen.findByTestId('admin-error-state')).toHaveTextContent('Missing permission: support:read');
    expect(screen.getByTestId('admin-error-state')).not.toHaveTextContent('status code');
  });

  it('falls back to a message-shaped body for endpoints outside the error envelope', async () => {
    run = apiError(500, { message: 'Run document is corrupt' });
    renderPage();

    expect(await screen.findByTestId('admin-error-state')).toHaveTextContent('Run document is corrupt');
  });
});

describe('DiscoveryRunPage decisions', () => {
  it('leads a flagged price with the plain reason, then the whole detail once', async () => {
    await renderLoaded();

    const card = screen.getByTestId('discovery-decision-gpt-5.6-luna');
    expect(card).toHaveTextContent('GPT 5.6 Luna');
    const flag = screen.getByTestId('discovery-decision-flag-gpt-5.6-luna');
    expect(flag).toHaveTextContent('Sources disagree on this price');
    expect(flag).toHaveTextContent(LUNA_FLAG.detail);
    expect(flag.textContent?.split('models.dev')).toHaveLength(2);
    expect(flag).not.toHaveTextContent('Proposed');
    expect(flag).not.toHaveTextContent('source-disagreement');

    fireEvent.click(screen.getByTestId('discovery-decision-action-gpt-5.6-luna'));
    expect(m.nav.openPrices).toHaveBeenCalledWith('gpt-5.6-luna');
  });

  it.each([
    ['price-none', 'add-price', 'Add price', 'openPrices', 'gpt-new'],
    ['lifecycle-suggestion', 'review-lifecycle', 'Review suggestion', 'openSection', 'discovery'],
  ] as const)('renders the server fix action for a %s reason (%s)', async (code, fixAction, label, navCall, navArg) => {
    run = runWith({ priceFlags: [], changes: { ...EMPTY_CHANGES, added: ['gpt-new'] } });
    rows = [needsReview('gpt-new', code, 'The reason the server wrote', fixAction)];
    await renderLoaded();

    expect(screen.getByTestId('discovery-decision-reasons-gpt-new')).toHaveTextContent('The reason the server wrote');
    const action = screen.getByTestId('discovery-decision-action-gpt-new');
    expect(action).toHaveTextContent(label);
    expect(action).toHaveAttribute('data-action', fixAction);
    fireEvent.click(action);
    expect(m.nav[navCall]).toHaveBeenCalledWith(navArg);
  });

  it('starts a discovery run from a run-discovery fix action', async () => {
    run = runWith({ priceFlags: [], changes: { ...EMPTY_CHANGES, added: ['gpt-new'] } });
    rows = [needsReview('gpt-new', 'awaiting-discovery-run', 'The reason the server wrote', 'run-discovery')];
    const served = m.get.getMockImplementation()!;
    m.get.mockImplementation(async (url: string, config?: { params?: { runId?: string } }) =>
      url === '/api/admin/model-discovery' && !config ? { data: { enabled: true, lastRun: null } } : served(url, config)
    );
    m.post.mockResolvedValue({ data: { dispatched: 'lambda' } });
    const { unmount } = await renderLoaded();

    const action = screen.getByTestId('discovery-decision-action-gpt-new');
    expect(action).toHaveTextContent('Run discovery');
    fireEvent.click(action);

    await waitFor(() => expect(useRunNowStore.getState().phase).toBe('waiting'));
    expect(m.post).toHaveBeenCalledWith('/api/admin/model-discovery');
    expect(action).toBeDisabled();
    expect(m.nav.openSection).not.toHaveBeenCalled();
    unmount();
    await waitFor(() => expect(useRunNowStore.getState().phase).toBe('idle'));
  });

  it('opens key settings for the model provider', async () => {
    run = runWith({ priceFlags: [], changes: { ...EMPTY_CHANGES, added: ['gpt-new'] } });
    rows = [needsReview('gpt-new', 'manual-approval-required', 'Needs a key', 'open-key-settings')];
    await renderLoaded();
    fireEvent.click(screen.getByTestId('discovery-decision-action-gpt-new'));

    expect(m.navigate).toHaveBeenCalledWith({
      to: '/admin',
      search: { tab: ADMIN_SETTINGS_TAB_SLUG, [ADMIN_SETTINGS_SEARCH_PARAM]: 'openai' },
    });
  });

  it('links every decision card to its model page', async () => {
    run = runWith({ changes: { ...EMPTY_CHANGES, added: ['gpt-new'] } });
    rows = [
      adminRow('gpt-5.6-luna', { name: 'GPT 5.6 Luna' }),
      needsReview('gpt-new', 'manual-approval-required', 'Waiting for approval'),
    ];
    await renderLoaded();

    for (const id of ['gpt-5.6-luna', 'gpt-new']) {
      fireEvent.click(screen.getByTestId(`discovery-decision-open-${id}`));
      expect(m.nav.openModel).toHaveBeenLastCalledWith(id);
    }
  });

  it('keeps a write-mode flag card for a model the list does not carry, with Open prices and no Open model', async () => {
    rows = [];
    await renderLoaded();

    const card = screen.getByTestId('discovery-decision-gpt-5.6-luna');
    expect(card).toHaveTextContent('gpt-5.6-luna');
    expect(screen.getByTestId('discovery-decision-flag-gpt-5.6-luna')).toHaveTextContent(LUNA_FLAG.detail);
    expect(screen.queryByTestId('discovery-decision-not-saved-gpt-5.6-luna')).not.toBeInTheDocument();
    expect(screen.queryByTestId('discovery-decision-open-gpt-5.6-luna')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('discovery-decision-action-gpt-5.6-luna'));
    expect(m.nav.openPrices).toHaveBeenCalledWith('gpt-5.6-luna');
  });

  it('shows no button when the server gives the reason no fix action', async () => {
    run = runWith({ priceFlags: [], changes: { ...EMPTY_CHANGES, added: ['gpt-new'] } });
    rows = [needsReview('gpt-new', 'manual-approval-required', 'Waiting for approval')];
    await renderLoaded();

    expect(screen.getByTestId('discovery-decision-reasons-gpt-new')).toHaveTextContent('Waiting for approval');
    expect(screen.queryByTestId('discovery-decision-action-gpt-new')).not.toBeInTheDocument();
  });

  it('keeps flag cards and claims nothing about catalog rows when model status fails to load', async () => {
    run = runWith({
      mode: 'report',
      changes: { ...EMPTY_CHANGES, added: ['gpt-planned'], flagged: ['gpt-5.6-luna'] },
      catalogDiff: [
        {
          modelId: 'gpt-planned',
          kind: 'added',
          ownedGroups: [],
          changedKeys: [],
          lifecycleStatus: 'active',
          promoted: false,
          blockedBy: ['no-trusted-price'],
          operatorOwned: false,
        },
      ],
    });
    modelsError = apiError(500, { error: 'list down' });
    renderPage();
    await screen.findByText(/Could not load each model/);

    expect(screen.queryByTestId('discovery-decision-action-gpt-5.6-luna')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('discovery-decision-open-gpt-5.6-luna'));
    expect(m.nav.openModel).toHaveBeenCalledWith('gpt-5.6-luna');
    expect(screen.getByTestId('discovery-decision-flag-gpt-5.6-luna')).toHaveTextContent('Sources disagree');
    expect(screen.getByTestId('discovery-decision-reasons-gpt-planned')).toHaveTextContent('No price yet.');
    expect(screen.queryByTestId('discovery-decision-not-saved-gpt-planned')).not.toBeInTheDocument();
    expect(screen.queryByTestId('discovery-decision-not-saved-gpt-5.6-luna')).not.toBeInTheDocument();
  });

  it('keeps a write-mode flag card with Open prices and Open model when model status fails to load', async () => {
    modelsError = apiError(500, { error: 'list down' });
    renderPage();

    expect(await screen.findByTestId('discovery-decision-action-gpt-5.6-luna')).toHaveTextContent('Open prices');
    expect(screen.getByTestId('discovery-decision-open-gpt-5.6-luna')).toBeInTheDocument();
  });

  it('offers no Open prices on a report-mode card for a model the list does not carry', async () => {
    run = runWith({ mode: 'report', changes: { ...EMPTY_CHANGES, added: ['gpt-5.6-luna'] } });
    rows = [];
    await renderLoaded();

    expect(screen.getByTestId('discovery-decision-flag-gpt-5.6-luna')).toHaveTextContent('Sources disagree');
    expect(screen.queryByTestId('discovery-decision-action-gpt-5.6-luna')).not.toBeInTheDocument();
    expect(screen.queryByTestId('discovery-decision-open-gpt-5.6-luna')).not.toBeInTheDocument();
  });

  it.each(['write', 'report'] as const)(
    'claims nothing about a missing row in a %s-mode run when the model lookup stopped at its cap',
    async mode => {
      run = runWith({
        mode,
        priceFlags: [],
        changes: { ...EMPTY_CHANGES, added: ['gpt-planned'] },
        catalogDiff: [
          {
            modelId: 'gpt-planned',
            kind: 'added',
            ownedGroups: [],
            changedKeys: [],
            lifecycleStatus: 'active',
            promoted: false,
            blockedBy: ['no-trusted-price'],
            operatorOwned: false,
          },
        ],
      });
      rows = [adminRow('gpt-5.6-luna', { name: 'GPT 5.6 Luna' })];
      modelsTotal = 6000;
      await renderLoaded();

      expect(screen.getByTestId('discovery-run-index-truncated')).toHaveTextContent('stopped at its cap');
      expect(screen.getByTestId('discovery-decision-reasons-gpt-planned')).toHaveTextContent('No price yet.');
      expect(screen.queryByTestId('discovery-decision-not-saved-gpt-planned')).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId('discovery-decision-open-gpt-planned'));
      expect(m.nav.openModel).toHaveBeenCalledWith('gpt-planned');
    }
  );

  it('skips a touched model that no longer needs a decision', async () => {
    run = runWith({ priceFlags: [], changes: { ...EMPTY_CHANGES, added: ['gpt-new'], promoted: ['gpt-new'] } });
    rows = [adminRow('gpt-new')];
    await renderLoaded();

    expect(screen.getByTestId('discovery-run-decisions')).toHaveTextContent(
      'Nothing from this run needs your decision.'
    );
  });

  it('marks a report-mode model as not saved, with what it would need and no action', async () => {
    run = runWith({
      mode: 'report',
      priceFlags: [],
      changes: { ...EMPTY_CHANGES, added: ['gpt-planned'] },
      catalogDiff: [
        {
          modelId: 'gpt-planned',
          kind: 'added',
          ownedGroups: [],
          changedKeys: [],
          lifecycleStatus: 'active',
          promoted: false,
          blockedBy: ['no-trusted-price'],
          operatorOwned: false,
        },
      ],
    });
    rows = [];
    await renderLoaded();

    expect(screen.getByTestId('discovery-decision-not-saved-gpt-planned')).toHaveTextContent(
      'Not saved: this run only reported'
    );
    expect(screen.getByTestId('discovery-decision-reasons-gpt-planned')).toHaveTextContent('No price yet.');
    expect(screen.queryByTestId('discovery-decision-action-gpt-planned')).not.toBeInTheDocument();
    expect(screen.queryByTestId('discovery-decision-open-gpt-planned')).not.toBeInTheDocument();
  });

  it('shows no blocker or flag code outside Run details', async () => {
    run = runWith({
      mode: 'report',
      changes: { ...EMPTY_CHANGES, added: ['gpt-planned', 'gpt-waiting'], flagged: ['gpt-5.6-luna'] },
      catalogDiff: ['no-trusted-price', 'manual-approval-required'].map((code, i) => ({
        modelId: i === 0 ? 'gpt-planned' : 'gpt-waiting',
        kind: 'added',
        ownedGroups: [],
        changedKeys: [],
        lifecycleStatus: 'active',
        promoted: false,
        blockedBy: [code],
        operatorOwned: false,
      })),
      skippedSources: [{ name: 'xai', reason: 'not-configured' }],
    });
    rows = [];
    await renderLoaded();

    const page = screen.getByTestId('discovery-run-page');
    for (const code of ['no-trusted-price', 'manual-approval-required', 'source-disagreement', 'not-configured']) {
      expect(page).not.toHaveTextContent(code);
    }
    expect(screen.getByTestId('discovery-run-summary')).toHaveTextContent('1 needs a price. 1 waits for approval.');

    openDetails();
    const details = screen.getByTestId('discovery-run-details');
    expect(within(details).getByTestId('discovery-run-catalog-row-gpt-planned')).toHaveTextContent('no-trusted-price');
    expect(within(details).getByTestId('discovery-run-flag-row-gpt-5.6-luna')).toHaveTextContent('source-disagreement');
  });
});

describe('DiscoveryRunPage what changed', () => {
  it('groups added, listed, repriced and lifecycle changes, and links each name to the model', async () => {
    run = runWith({
      priceFlags: [],
      changes: { ...EMPTY_CHANGES, added: ['gpt-new'], promoted: ['gpt-new'], repriced: ['gpt-cheap'] },
      priceRows: [priceRow('gpt-cheap', 'openrouter', 0.5)],
      lifecycleTransitions: [
        {
          modelId: 'gpt-sunset',
          from: 'active',
          to: 'deprecated',
          signal: 'typed',
          deprecationDate: '2026-08-01',
          replacedBy: 'gpt-live',
          autoApplied: true,
        },
      ],
    });
    rows = [adminRow('gpt-new', { name: 'GPT New' }), adminRow('gpt-live', { name: 'GPT Live' })];
    await renderLoaded();

    expect(screen.getByTestId('discovery-changed-added')).toHaveTextContent('Added');
    expect(screen.getByTestId('discovery-changed-added-gpt-new')).toHaveTextContent('GPT New');
    expect(screen.getByTestId('discovery-changed-added-gpt-new')).toHaveTextContent('Listed');
    expect(screen.getByTestId('discovery-changed-listed-gpt-new')).toBeInTheDocument();
    expect(screen.getByTestId('discovery-changed-repriced-gpt-cheap-0')).toHaveTextContent('$0.5 in / $15 out per 1M');
    const lifecycle = screen.getByTestId('discovery-changed-lifecycle-gpt-sunset-0');
    expect(lifecycle).toHaveTextContent('Active to deprecated, deprecates 2026-08-01, replaced by GPT Live');
    expect(lifecycle).toHaveTextContent('Applied');

    fireEvent.click(
      within(screen.getByTestId('discovery-changed-added-gpt-new')).getByTestId('discovery-changed-open-model-link')
    );
    expect(m.nav.openModel).toHaveBeenCalledWith('gpt-new');
  });

  it('lists a row recorded from the build apart from a reprice', async () => {
    run = runWith({
      priceFlags: [],
      changes: { ...EMPTY_CHANGES, plannedPriceRows: 5, appendedPriceRows: 5 },
      priceRows: [
        priceRow('gpt-cheap', 'openrouter'),
        priceRow('kimi-k3', 'adapter-literal'),
        { ...priceRow('glm-5', 'adapter-literal'), sources: ['adapter-literal', 'models.dev'] },
      ],
      detailTotals: { priceRows: 5 },
    });
    await renderLoaded();

    expect(screen.getByTestId('discovery-changed-repriced-gpt-cheap-0')).toBeInTheDocument();
    expect(screen.queryByTestId('discovery-changed-repriced-kimi-k3-1')).not.toBeInTheDocument();

    openDetails();
    expect(screen.getByTestId('discovery-run-price-rows-table-card')).toHaveTextContent(
      'Price rows (3 shown, 5 in the run)'
    );
    expect(screen.getByTestId('discovery-run-price-row-kimi-k3-1')).toHaveTextContent('Build table');
    expect(screen.getByTestId('discovery-run-price-row-glm-5-2')).toHaveTextContent('Build table, models.dev');
    expect(screen.getByTestId('discovery-run-price-row-gpt-cheap-0')).toHaveTextContent('openrouter');
  });

  it('names the source a provider price was written over', async () => {
    run = runWith({
      priceFlags: [],
      priceOverrides: [
        {
          modelId: 'gpt-5.6-luna',
          source: 'openai',
          dissenting: ['litellm'],
          applied: { inputPerMTok: 0.2, outputPerMTok: 1.2 },
          detail: 'openai and litellm disagree beyond 10%; the provider value wins',
        },
      ],
    });
    await renderLoaded();

    const item = screen.getByTestId('discovery-changed-overruled-price-gpt-5.6-luna');
    expect(item).toHaveTextContent('$0.2 in / $1.2 out per 1M from openai, over litellm.');
    expect(item).toHaveTextContent('the provider value wins');

    openDetails();
    const row = screen.getByTestId('discovery-run-price-override-row-gpt-5.6-luna');
    expect(row).toHaveTextContent('openai');
    expect(row).toHaveTextContent('litellm');
    expect(screen.getByTestId('discovery-run-price-overrides-table-card')).toHaveTextContent(
      'Overruled a disagreeing source (1)'
    );
  });

  it('does not claim anything was applied on a run that wrote nothing', async () => {
    run = runWith({
      mode: 'report',
      priceFlags: [],
      changes: { ...EMPTY_CHANGES, added: ['gpt-new'], promoted: ['gpt-new'] },
      lifecycleTransitions: [{ modelId: 'gpt-sunset', to: 'retired', signal: 'typed', autoApplied: true }],
      priceOverrides: [
        {
          modelId: 'gpt-5.6-luna',
          source: 'openai',
          dissenting: ['litellm'],
          applied: { inputPerMTok: 0.2, outputPerMTok: 1.2 },
          detail: 'the provider value would win',
        },
      ],
    });
    await renderLoaded();

    expect(screen.getByTestId('discovery-run-report-mode')).toHaveTextContent(
      'This run only reported. Nothing was saved.'
    );
    expect(screen.getByTestId('discovery-changed-added')).toHaveTextContent('Would add');
    expect(screen.getByTestId('discovery-changed-listed')).toHaveTextContent('Would list');
    expect(screen.getByTestId('discovery-changed-lifecycle-gpt-sunset-0')).toHaveTextContent('Would apply');
    expect(screen.getByTestId('discovery-run-changes')).not.toHaveTextContent(/\bApplied\b/);
    expect(screen.getByTestId('discovery-run-summary')).toHaveTextContent('Would list 1.');
  });

  it('shows admin-owned conflicts as overruled sources', async () => {
    run = runWith({ priceFlags: [], changes: { ...EMPTY_CHANGES, operatorConflicts: ['gpt-owned'] } });
    await renderLoaded();

    expect(screen.getByTestId('discovery-changed-overruled-gpt-owned')).toHaveTextContent('Set by admin');
    openDetails();
    expect(screen.getByTestId('discovery-run-operator-conflicts')).toHaveTextContent('gpt-owned');
  });

  it('says so when the run changed nothing, and renders a run written before overrides existed', async () => {
    run = runWith({ priceFlags: [], priceOverrides: undefined, changes: EMPTY_CHANGES });
    await renderLoaded();

    expect(screen.getByTestId('discovery-run-changes')).toHaveTextContent('This run changed nothing.');
    openDetails();
    expect(screen.queryByTestId('discovery-run-price-overrides-table-card')).not.toBeInTheDocument();
  });
});

describe('DiscoveryRunPage banners', () => {
  it('calls out planned price rows that never landed, even on a run reporting ok', async () => {
    run = runWith({ changes: { ...EMPTY_CHANGES, plannedPriceRows: 3, appendedPriceRows: 1 } });
    await renderLoaded();

    expect(screen.getByTestId('discovery-run-write-gap')).toHaveTextContent('3 price rows planned, 1 appended');
    expect(screen.getByTestId('discovery-run-write-gap')).toHaveTextContent('The run still reports finished.');
  });

  it('says nothing about write gaps when every planned row landed', async () => {
    await renderLoaded();

    expect(screen.queryByTestId('discovery-run-write-gap')).not.toBeInTheDocument();
  });

  it('reads a report-mode run as a plan that wrote nothing, not as lost writes', async () => {
    run = runWith({ mode: 'report', changes: { ...EMPTY_CHANGES, plannedRows: 4, plannedPriceRows: 2 } });
    await renderLoaded();

    expect(screen.getByTestId('discovery-run-report-mode')).toBeInTheDocument();
    expect(screen.queryByTestId('discovery-run-write-gap')).not.toBeInTheDocument();
    expect(screen.getByTestId('discovery-run-result')).toHaveTextContent('Report only');
  });

  it('stays silent about the mode on a run document written before the field existed', async () => {
    run = runWith({ mode: undefined, changes: { ...EMPTY_CHANGES, plannedPriceRows: 2 } });
    await renderLoaded();

    expect(screen.queryByTestId('discovery-run-report-mode')).not.toBeInTheDocument();
    expect(screen.queryByTestId('discovery-run-write-gap')).not.toBeInTheDocument();
    openDetails();
    expect(screen.getByTestId('discovery-run-fact-mode')).toHaveTextContent('Not recorded');
  });
});

describe('DiscoveryRunPage run details', () => {
  it('stays collapsed until asked for', async () => {
    await renderLoaded();

    const toggle = screen.getByTestId('discovery-run-details-toggle');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('discovery-run-details')).not.toBeInTheDocument();
    openDetails();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('discovery-run-facts')).toHaveTextContent('run-1');
  });

  it('carries the counters, coverage, passes, unmatched ids and frozen profiles', async () => {
    run = runWith({
      unmatchedIds: ['gpt-orphan'],
      frozenProfileIds: ['us.example.legacy-v1:0'],
      changes: { ...RUN.changes, plannedRows: 3, appendedRows: 3 },
    });
    await renderLoaded();
    openDetails();

    expect(screen.getByTestId('discovery-run-fact-result')).toHaveTextContent('Finished (ok)');
    expect(screen.getByTestId('discovery-run-passes')).toHaveTextContent('2');
    expect(screen.getByTestId('discovery-run-catalog-counter')).toHaveTextContent('3 of 3 planned appended');
    expect(screen.getByTestId('discovery-run-price-counter')).toHaveTextContent('1 of 1 planned appended');
    expect(screen.getByTestId('discovery-run-coverage')).toHaveTextContent('models.dev 84 of 113 matched');
    expect(screen.getByTestId('discovery-run-unmatched')).toHaveTextContent('gpt-orphan');
    expect(screen.getByTestId('discovery-run-frozen-profiles')).toHaveTextContent('us.example.legacy-v1:0');
  });

  it('omits the frozen profiles when none are frozen', async () => {
    await renderLoaded();
    openDetails();

    expect(screen.getByTestId('discovery-run-frozen-profiles')).toHaveTextContent('-');
  });

  it('reads a skipped source as skipped rather than as a failure', async () => {
    run = runWith({ skippedSources: [{ name: 'xai', reason: 'not-configured' }] });
    await renderLoaded();
    openDetails();

    expect(screen.getByTestId('discovery-run-source-row-models.dev')).toHaveTextContent('ok');
    expect(screen.getByTestId('discovery-run-source-row-litellm')).toHaveTextContent('failed');
    expect(screen.getByTestId('discovery-run-source-row-litellm')).toHaveTextContent('ETIMEDOUT');
    const skipped = screen.getByTestId('discovery-run-skipped-row-xai');
    expect(skipped).toHaveTextContent('skipped');
    expect(skipped).toHaveTextContent('not configured');
    expect(skipped).not.toHaveTextContent('failed');
  });

  it('renders the sources table for a run that attempted nothing at all', async () => {
    run = runWith({ sources: [], skippedSources: [{ name: 'openai', reason: 'egress-disabled' }] });
    await renderLoaded();
    openDetails();

    expect(screen.getByTestId('discovery-run-skipped-row-openai')).toHaveTextContent('outbound calls are off');
  });

  it.each([
    ['[]', []],
    ['missing', undefined],
  ])('renders a run whose skipped sources are %s', async (_label, skippedSources) => {
    run = runWith({ skippedSources });
    await renderLoaded();
    openDetails();

    expect(screen.getByTestId('discovery-run-sources-table-card')).toHaveTextContent('Sources (2)');
  });

  it('says which tables show only the first rows of a wider run', async () => {
    run = runWith({ detailTotals: { priceFlags: 240 } });
    await renderLoaded();
    openDetails();

    expect(screen.getByTestId('discovery-run-price-flags-table-card')).toHaveTextContent(
      'Price flags (first 1 of 240)'
    );
  });

  it('renders the lifecycle and catalog tables with every column the run carries', async () => {
    run = runWith({
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
          blockedBy: ['no-trusted-price'],
          operatorOwned: false,
        },
      ],
      priceSkips: [{ modelId: 'gpt-owned', reason: 'operator-owned' }],
      droppedRecords: [{ source: 'models.dev', modelId: 'bad-record', reason: 'no id' }],
    });
    await renderLoaded();
    openDetails();

    const lifecycle = screen.getByTestId('discovery-run-lifecycle-row-gpt-sunset-0');
    expect(lifecycle).toHaveTextContent('active -> deprecated');
    expect(lifecycle).toHaveTextContent('Provider feed');
    expect(lifecycle).toHaveTextContent('2026-08-01');
    expect(lifecycle).toHaveTextContent('gpt-live');
    expect(lifecycle).toHaveTextContent('suggestion');
    const catalog = screen.getByTestId('discovery-run-catalog-row-gpt-new');
    expect(catalog).toHaveTextContent('contextWindow');
    expect(catalog).toHaveTextContent('No price yet.');
    expect(screen.getByTestId('discovery-run-skips-table-card')).toHaveTextContent('Price set by an admin');
    expect(screen.getByTestId('discovery-run-dropped-table-card')).toHaveTextContent('bad-record');
  });

  it('renders two passes of the same model as two rows, with distinct keys and testids', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    run = runWith({
      priceRows: [priceRow('gpt-twice', 'openai', 1), priceRow('gpt-twice', 'openai', 2)],
      lifecycleTransitions: [
        { modelId: 'gpt-sunset', to: 'deprecated', signal: 'absence', autoApplied: false },
        { modelId: 'gpt-sunset', to: 'retired', signal: 'typed', autoApplied: true },
      ],
    });
    await renderLoaded();
    openDetails();

    expect(screen.getByTestId('discovery-run-price-row-gpt-twice-0')).toHaveTextContent('$1');
    expect(screen.getByTestId('discovery-run-price-row-gpt-twice-1')).toHaveTextContent('$2');
    expect(screen.getByTestId('discovery-run-lifecycle-row-gpt-sunset-0')).toHaveTextContent('deprecated');
    expect(screen.getByTestId('discovery-run-lifecycle-row-gpt-sunset-1')).toHaveTextContent('retired');
    expect(screen.getByTestId('discovery-changed-repriced-gpt-twice-1')).toBeInTheDocument();
    expect(consoleError.mock.calls.flat().join(' ')).not.toContain('same key');
    consoleError.mockRestore();
  });
});
