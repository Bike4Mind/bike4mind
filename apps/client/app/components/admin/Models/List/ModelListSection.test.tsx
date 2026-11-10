import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ModelAccessBulkDryRun, ModelAccessBulkResult } from '@bike4mind/common';
import { apiFailure, listResponse, modelRow, renderModelsRoute } from '../modelsTestUtils';
import { useRunNowStore } from '../Discovery/runDiscoveryNow';

const { get, post, patch, user } = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  user: { current: { isAdmin: true } as Record<string, unknown> },
}));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get, post, patch } }));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: user.current }) }));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

import { ModelListSection } from './ModelListSection';

type Params = Record<string, string>;
const listCalls = () =>
  get.mock.calls
    .filter(([url]) => url === '/api/admin/models')
    .map(([, config]) => (config as { params: Params }).params);
const bulkBodies = () =>
  post.mock.calls.filter(([url]) => url === '/api/admin/models/access/bulk').map(([, body]) => body);

const reviewRow = modelRow({
  id: 'example-text-2',
  name: 'Example Text 2',
  status: 'needs-review',
  rank: 4,
  rankProvisional: true,
  price: null,
  reasons: [
    { code: 'price-none', message: 'No price yet. New models list once they have a price.', fixAction: 'add-price' },
  ],
});
const adminOnlyRow = modelRow({
  id: 'example-image-1',
  name: 'Example Image 1',
  type: 'image',
  status: 'limited',
  access: {
    entry: { enabled: true, allowedUserTags: [], allowedEntitlements: [], updatedAt: '2026-11-02T00:00:00.000Z' },
    everyone: false,
    adminsOnly: true,
    freeTierLocked: false,
  },
});
const listedRow = modelRow();

const serveList = (byView: (view: string) => ReturnType<typeof listResponse>) =>
  get.mockImplementation(async (url: string, config?: { params?: Params }) => {
    if (url === '/api/admin/models') return { data: byView(config?.params?.view ?? '') };
    if (url === '/api/admin/users/tags') return { data: { tags: [{ tag: 'beta', count: 37 }] } };
    throw new Error(`unexpected GET ${url}`);
  });

const dryRun = (overrides: Partial<ModelAccessBulkDryRun> = {}): ModelAccessBulkDryRun => ({
  ids: ['example-text-1', 'example-text-2'],
  items: [
    {
      id: 'example-text-1',
      before: null,
      after: { id: 'example-text-1', enabled: true, allowedUserTags: ['beta'], allowedEntitlements: ['base'] },
      changes: true,
      audience: 'none',
      everyoneThroughBase: true,
      adminOnly: false,
    },
    {
      id: 'example-text-2',
      before: null,
      after: { id: 'example-text-2', enabled: true, allowedUserTags: ['beta'], allowedEntitlements: ['base'] },
      changes: true,
      audience: 'none',
      everyoneThroughBase: true,
      adminOnly: false,
    },
  ],
  counts: { selected: 2, change: 2, unchanged: 0, noAudienceChange: 2, adminOnly: 0 },
  adminOnlyIds: [],
  token: 'token-1',
  expiresAt: '2026-11-10T20:00:00.000Z',
  ...overrides,
});

const selectPage = async () => {
  await screen.findByTestId('models-row-example-text-1');
  fireEvent.click(within(screen.getByTestId('admin-table-select-page')).getByRole('checkbox'));
};

const pickReason = (dialog: string) => fireEvent.click(screen.getByTestId(`${dialog}-reason-input-preset-0`));

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  patch.mockReset();
  user.current = { isAdmin: true };
});
afterEach(() => {
  cleanup();
  useRunNowStore.setState({ phase: 'idle', notice: null, error: null });
});

describe('ModelListSection views', () => {
  it('opens on Needs review while it holds models, asking the server for that view by name', async () => {
    serveList(view =>
      listResponse(view === 'needs-review' ? [reviewRow] : [reviewRow, listedRow], {
        viewCounts: { 'needs-review': 1, all: 2 },
      })
    );
    await renderModelsRoute('/admin?tab=models', ModelListSection);

    expect(await screen.findByTestId('models-row-example-text-2')).toBeInTheDocument();
    expect(listCalls().every(params => params.view === 'needs-review')).toBe(true);
    expect(screen.getByTestId('models-row-reason')).toHaveTextContent('No price yet.');
    expect(screen.getByTestId('models-row-fix-btn')).toHaveTextContent('Add price');
    expect(screen.getByTestId('models-row-rank-provisional')).toHaveTextContent('4*');
  });

  it('falls back to All when nothing needs review', async () => {
    serveList(view => listResponse(view === 'needs-review' ? [] : [listedRow], { viewCounts: { all: 1 } }));
    await renderModelsRoute('/admin?tab=models', ModelListSection);

    expect(await screen.findByTestId('models-row-example-text-1')).toBeInTheDocument();
    expect(listCalls().at(-1)?.view).toBe('all');
  });

  it('shows the loading state, not an empty All, while switching from an empty Needs review', async () => {
    let resolveAll: (value: { data: ReturnType<typeof listResponse> }) => void = () => {};
    get.mockImplementation((url: string, config?: { params?: Params }) => {
      if (url !== '/api/admin/models') throw new Error(`unexpected GET ${url}`);
      if (config?.params?.view === 'all') return new Promise(resolve => (resolveAll = resolve));
      return Promise.resolve({ data: listResponse([], { viewCounts: { all: 1 } }) });
    });
    await renderModelsRoute('/admin?tab=models', ModelListSection);

    await waitFor(() => expect(listCalls().some(params => params.view === 'all')).toBe(true));
    expect(screen.queryByText(/No models in/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('models-show-all-btn')).not.toBeInTheDocument();

    resolveAll({ data: listResponse([listedRow], { viewCounts: { all: 1 } }) });
    expect(await screen.findByTestId('models-row-example-text-1')).toBeInTheDocument();
  });

  it('sorts from a column header and goes back to page 1', async () => {
    serveList(() => listResponse([listedRow, reviewRow], { total: 240 }));
    const { router } = await renderModelsRoute('/admin?tab=models&modelsView=all&modelsPage=3', ModelListSection);

    await screen.findByTestId('models-row-example-text-1');
    expect(listCalls().at(-1)).toMatchObject({ page: '3' });
    fireEvent.click(screen.getByTestId('admin-table-sort-rank-btn'));

    await waitFor(() => expect(router.state.location.search).toMatchObject({ modelsSort: 'rank', modelsDir: 'asc' }));
    expect(router.state.location.search).not.toHaveProperty('modelsPage');
    await waitFor(() => expect(listCalls().at(-1)).toMatchObject({ sort: 'rank', dir: 'asc', page: '1' }));

    fireEvent.click(screen.getByTestId('admin-table-sort-rank-btn'));
    await waitFor(() => expect(listCalls().at(-1)).toMatchObject({ sort: 'rank', dir: 'desc', page: '1' }));
  });

  it('holds selection while the table still shows the previous page', async () => {
    let resolvePage2: (value: { data: ReturnType<typeof listResponse> }) => void = () => {};
    get.mockImplementation((url: string, config?: { params?: Params }) => {
      if (url !== '/api/admin/models') throw new Error(`unexpected GET ${url}`);
      if (config?.params?.page === '2') return new Promise(resolve => (resolvePage2 = resolve));
      return Promise.resolve({ data: listResponse([listedRow, reviewRow], { total: 240 }) });
    });
    const { router } = await renderModelsRoute('/admin?tab=models&modelsView=all', ModelListSection);

    await screen.findByTestId('models-row-example-text-1');
    fireEvent.click(within(screen.getByTestId('admin-table-select-example-text-1')).getByRole('checkbox'));
    expect(screen.getByTestId('admin-select-all-matching-btn')).not.toBeDisabled();

    await act(() => router.navigate({ to: '/admin', search: { tab: 'models', modelsView: 'all', modelsPage: '2' } }));
    await waitFor(() => expect(listCalls().some(params => params.page === '2')).toBe(true));
    expect(within(screen.getByTestId('admin-table-select-page')).getByRole('checkbox')).toBeDisabled();
    expect(within(screen.getByTestId('admin-table-select-example-text-2')).getByRole('checkbox')).toBeDisabled();
    expect(screen.getByTestId('admin-select-all-matching-btn')).toBeDisabled();

    resolvePage2({ data: listResponse([listedRow, reviewRow], { total: 240 }) });
    await waitFor(() => expect(screen.getByTestId('admin-select-all-matching-btn')).not.toBeDisabled());
    expect(within(screen.getByTestId('admin-table-select-page')).getByRole('checkbox')).not.toBeDisabled();
  });

  it('shows why the models could not be loaded', async () => {
    get.mockRejectedValue(apiFailure(503, { error: 'Model catalog is unavailable' }));
    await renderModelsRoute('/admin?tab=models&modelsView=all', ModelListSection);

    expect(await screen.findByTestId('admin-error-state')).toHaveTextContent(
      "Couldn't load the models. Model catalog is unavailable"
    );
  });

  it('follows a deep-linked view, filters and sort', async () => {
    serveList(() => listResponse([listedRow], { viewCounts: { 'needs-review': 3 } }));
    await renderModelsRoute(
      '/admin?tab=models&modelsView=listed&modelsProvider=openai&modelsType=image&modelsSort=rank&modelsDir=desc&modelsQuery=example',
      ModelListSection
    );

    await screen.findByTestId('models-row-example-text-1');
    expect(listCalls().at(-1)).toMatchObject({
      view: 'listed',
      providers: 'openai',
      types: 'image',
      sort: 'rank',
      dir: 'desc',
      search: 'example',
    });
  });

  it('marks an enabled model nobody can pick as Admins only', async () => {
    serveList(() => listResponse([adminOnlyRow]));
    await renderModelsRoute('/admin?tab=models&modelsView=all', ModelListSection);

    expect(await screen.findByTestId('models-row-admins-only')).toHaveTextContent('Admins only');
  });

  it('brings back the hidden Bedrock foundation ids from the chip', async () => {
    serveList(() => listResponse([listedRow], { foundationIds: 3 }));
    const { router } = await renderModelsRoute('/admin?tab=models&modelsView=all', ModelListSection);

    fireEvent.click(await screen.findByTestId('models-foundation-show-btn'));
    await waitFor(() => expect(router.state.location.search).toMatchObject({ modelsFoundation: '1' }));
    await waitFor(() => expect(listCalls().at(-1)?.showFoundationIds).toBe('true'));
  });
});

describe('ModelListSection single-model access', () => {
  it('turns a model off through the access PATCH with the stamp it read', async () => {
    serveList(() => listResponse([listedRow]));
    patch.mockResolvedValue({ data: { entry: null, changed: true, revision: 'r2' } });
    await renderModelsRoute('/admin?tab=models&modelsView=all', ModelListSection);

    const row = await screen.findByTestId('models-row-example-text-1');
    fireEvent.click(within(row).getByTestId('models-row-menu-btn'));
    fireEvent.click(await screen.findByTestId('models-row-toggle-item'));
    pickReason('model-access-dialog');
    fireEvent.click(screen.getByTestId('model-access-dialog-confirm-btn'));

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch.mock.calls[0]).toEqual([
      '/api/admin/models/access',
      expect.objectContaining({ change: { enabled: false }, expectedUpdatedAt: '2026-11-01T00:00:00.000Z' }),
      { params: { id: 'example-text-1' } },
    ]);
  });

  it('shows the stale-entry 409 with a reload instead of retrying blind', async () => {
    serveList(() => listResponse([listedRow]));
    patch.mockRejectedValue(
      apiFailure(409, {
        error: "Someone changed this model's access since you opened it. Reload and try again.",
        entry: null,
      })
    );
    await renderModelsRoute('/admin?tab=models&modelsView=all', ModelListSection);

    fireEvent.click(within(await screen.findByTestId('models-row-example-text-1')).getByTestId('models-row-menu-btn'));
    fireEvent.click(await screen.findByTestId('models-row-toggle-item'));
    pickReason('model-access-dialog');
    fireEvent.click(screen.getByTestId('model-access-dialog-confirm-btn'));

    expect(await screen.findByTestId('model-access-conflict')).toHaveTextContent('Someone changed');
    expect(screen.getByTestId('model-access-reload-btn')).toBeInTheDocument();
  });

  it('keeps a blocked fix action in a row from opening the model', async () => {
    user.current = { isAdmin: false, adminPermissions: ['settings:manage'] };
    const offRow = modelRow({
      status: 'hidden',
      reasons: [{ code: 'admin-off', message: 'Turned off by an admin', fixAction: 'turn-on' }],
    });
    serveList(() => listResponse([offRow]));
    const { router } = await renderModelsRoute('/admin?tab=models&modelsView=all', ModelListSection);

    const fix = within(await screen.findByTestId('models-row-example-text-1')).getByTestId('models-row-fix-btn');
    expect(fix).toBeDisabled();
    fireEvent.click(screen.getByTestId('models-write-blocked-action'));
    await act(() => new Promise(resolve => setTimeout(resolve, 50)));

    expect(router.state.location.pathname).toBe('/admin');
    expect(screen.queryByTestId('probe-detail')).not.toBeInTheDocument();
    expect(screen.queryByTestId('model-access-dialog')).not.toBeInTheDocument();
  });

  it('starts a discovery run from the Run discovery fix action', async () => {
    const staleRow = modelRow({
      status: 'needs-review',
      reasons: [{ code: 'not-discovered', message: 'Not seen by discovery yet', fixAction: 'run-discovery' }],
    });
    get.mockImplementation(async (url: string) => {
      if (url === '/api/admin/models') return { data: listResponse([staleRow]) };
      if (url === '/api/admin/model-discovery') return { data: { enabled: true, lastRun: null } };
      throw new Error(`unexpected GET ${url}`);
    });
    post.mockResolvedValue({ data: { dispatched: 'lambda' } });
    await renderModelsRoute('/admin?tab=models&modelsView=all', ModelListSection);

    const fix = within(await screen.findByTestId('models-row-example-text-1')).getByTestId('models-row-fix-btn');
    expect(fix).toHaveTextContent('Run discovery');
    fireEvent.click(fix);

    await waitFor(() => expect(useRunNowStore.getState().phase).toBe('waiting'));
    expect(post).toHaveBeenCalledWith('/api/admin/model-discovery');
    expect(fix).toBeDisabled();
    expect(screen.queryByTestId('probe-detail')).not.toBeInTheDocument();
  });

  it('keeps writes visible but disabled for an admin who is not a full administrator', async () => {
    user.current = { isAdmin: false, adminPermissions: ['settings:manage', 'support:read'] };
    serveList(() => listResponse([listedRow]));
    await renderModelsRoute('/admin?tab=models&modelsView=all', ModelListSection);

    fireEvent.click(within(await screen.findByTestId('models-row-example-text-1')).getByTestId('models-row-menu-btn'));
    const toggle = await screen.findByTestId('models-row-toggle-item');
    expect(toggle).toHaveAttribute('aria-disabled', 'true');
    expect(toggle).toHaveTextContent('Only full administrators can manage models');
  });
});

describe('ModelListSection bulk access', () => {
  const twoRows = () => listResponse([listedRow, reviewRow], { total: 129 });

  it('adds a tag to every model matching the filter, with the view sent explicitly', async () => {
    serveList(twoRows);
    const result: ModelAccessBulkResult = {
      batchId: 'b1',
      results: [{ id: 'example-text-1', outcome: 'updated' }],
      counts: { selected: 2, updated: 2, unchanged: 0, failed: 0 },
      summary: 'Updated 2 of 2.',
      undoToken: 'undo-1',
      revision: 'r2',
    };
    post.mockImplementation(async (_url: string, body: { dryRunToken?: string }) => ({
      data: body.dryRunToken ? result : dryRun(),
    }));
    await renderModelsRoute('/admin?tab=models&modelsView=all&modelsProvider=anthropic', ModelListSection);

    await selectPage();
    fireEvent.click(screen.getByTestId('admin-select-all-matching-btn'));
    fireEvent.click(screen.getByTestId('models-bulk-add-tag-btn'));
    const input = screen.getByTestId('models-bulk-values-input');
    fireEvent.change(input, { target: { value: 'beta' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(await screen.findByTestId('models-bulk-summary')).toHaveTextContent('Add tag beta: 2 change');
    expect(bulkBodies()[0]).toEqual({
      selection: { filter: { view: 'all', providers: ['anthropic'], showFoundationIds: false } },
      change: { addTags: ['beta'] },
    });
    expect(screen.getByTestId('models-bulk-no-audience-change')).toHaveTextContent('No audience change for 2 models');
    expect(screen.getByTestId('models-bulk-audience')).toHaveTextContent('Afterwards 2 reach the same users');
    fireEvent.click(screen.getByTestId('models-bulk-changed-toggle-btn'));
    const [firstChanged] = screen.getAllByTestId('models-bulk-changed-item');
    expect(firstChanged).toHaveTextContent('example-text-1: Tags: none \u2192 beta');
    expect(firstChanged).toHaveTextContent('Same users as before');

    fireEvent.click(screen.getByTestId('models-bulk-also-remove-base-checkbox'));
    await waitFor(() =>
      expect(bulkBodies().at(-1)).toMatchObject({ change: { addTags: ['beta'], alsoRemoveBase: true } })
    );

    pickReason('models-bulk-dialog');
    await waitFor(() => expect(screen.getByTestId('models-bulk-dialog-confirm-btn')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('models-bulk-dialog-confirm-btn'));
    await waitFor(() =>
      expect(bulkBodies().at(-1)).toMatchObject({
        selection: { filter: { view: 'all' } },
        change: { addTags: ['beta'], alsoRemoveBase: true },
        dryRunToken: 'token-1',
        reason: 'Ready for users',
      })
    );
    expect(await screen.findByText(/Updated 2 of 2\./)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(bulkBodies().at(-1)).toEqual({ undoToken: 'undo-1', reason: 'Undo: Ready for users' }));
  });

  it('lists the models an undo could not revert, each linked to its page, and offers no reverse change', async () => {
    serveList(twoRows);
    const applied: ModelAccessBulkResult = {
      batchId: 'b1',
      results: [
        { id: 'example-text-1', outcome: 'updated' },
        { id: 'example-text-2', outcome: 'updated' },
      ],
      counts: { selected: 2, updated: 2, unchanged: 0, failed: 0 },
      summary: 'Updated 2 of 2',
      undoToken: 'undo-1',
      revision: 'r2',
    };
    const undone: ModelAccessBulkResult = {
      batchId: 'b2',
      results: [
        { id: 'example-text-1', outcome: 'updated' },
        { id: 'example-text-2', outcome: 'failed', reason: 'stamp-moved' },
      ],
      counts: { selected: 2, updated: 1, unchanged: 0, failed: 1 },
      summary: 'Updated 1 of 2. 1 failed',
      undoToken: null,
      revision: 'r3',
    };
    post.mockImplementation(async (_url: string, body: { dryRunToken?: string; undoToken?: string }) => ({
      data: body.undoToken ? undone : body.dryRunToken ? applied : dryRun(),
    }));
    const { router } = await renderModelsRoute('/admin?tab=models&modelsView=all', ModelListSection);

    await selectPage();
    fireEvent.click(screen.getByTestId('models-bulk-turn-off-btn'));
    await screen.findByTestId('models-bulk-summary');
    pickReason('models-bulk-dialog');
    fireEvent.click(screen.getByTestId('models-bulk-dialog-confirm-btn'));
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));

    const failed = await screen.findByTestId('models-bulk-failed');
    expect(failed).toHaveTextContent('Undo: 1 model reverted, 1 not reverted.');
    expect(screen.getByTestId('models-bulk-not-reverted-item')).toHaveTextContent(
      'example-text-2: changed since the batch'
    );
    expect(failed).toHaveTextContent("Change these back from each model's page.");
    expect(screen.queryByTestId('models-bulk-retry-btn')).not.toBeInTheDocument();
    expect(screen.getByTestId('undo-toast-message')).toHaveTextContent('Undo: 1 model reverted, 1 not reverted.');
    // The spent token is not offered again: a second undo would report the reverted models as moved.
    expect(screen.queryByTestId('undo-toast-undo-btn')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('models-bulk-not-reverted-link'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/models/example-text-2'));
  });

  it('undoes the original apply and its retry together, reporting both in one toast', async () => {
    serveList(twoRows);
    const applied: ModelAccessBulkResult = {
      batchId: 'b1',
      results: [
        { id: 'example-text-1', outcome: 'updated' },
        { id: 'example-text-2', outcome: 'failed', reason: 'write-error' },
      ],
      counts: { selected: 2, updated: 1, unchanged: 0, failed: 1 },
      summary: 'Updated 1 of 2. 1 failed',
      undoToken: 'undo-1',
      revision: 'r2',
    };
    const retried: ModelAccessBulkResult = {
      batchId: 'b2',
      results: [{ id: 'example-text-2', outcome: 'updated' }],
      counts: { selected: 1, updated: 1, unchanged: 0, failed: 0 },
      summary: 'Updated 1 of 1',
      undoToken: 'undo-2',
      revision: 'r3',
    };
    const undoOf = (id: string): ModelAccessBulkResult => ({
      batchId: `undo-${id}`,
      results: [{ id, outcome: 'updated' }],
      counts: { selected: 1, updated: 1, unchanged: 0, failed: 0 },
      summary: 'Updated 1 of 1',
      undoToken: null,
      revision: 'r4',
    });
    let applies = 0;
    post.mockImplementation(async (_url: string, body: { dryRunToken?: string; undoToken?: string }) => {
      if (body.undoToken) return { data: undoOf(body.undoToken === 'undo-1' ? 'example-text-1' : 'example-text-2') };
      if (body.dryRunToken) return { data: (applies += 1) === 1 ? applied : retried };
      return { data: dryRun() };
    });
    await renderModelsRoute('/admin?tab=models&modelsView=all', ModelListSection);

    await selectPage();
    fireEvent.click(screen.getByTestId('models-bulk-turn-off-btn'));
    await screen.findByTestId('models-bulk-summary');
    pickReason('models-bulk-dialog');
    fireEvent.click(screen.getByTestId('models-bulk-dialog-confirm-btn'));

    fireEvent.click(await screen.findByTestId('models-bulk-retry-btn'));
    await screen.findByTestId('models-bulk-summary');
    pickReason('models-bulk-dialog');
    await waitFor(() => expect(screen.getByTestId('models-bulk-dialog-confirm-btn')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('models-bulk-dialog-confirm-btn'));
    await waitFor(() => expect(screen.getByTestId('undo-toast-message')).toHaveTextContent('Updated 1 of 1'));

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(screen.getByTestId('undo-toast-message')).toHaveTextContent('Undo: 2 models reverted.'));
    const undoTokens = bulkBodies()
      .map(body => (body as { undoToken?: string }).undoToken)
      .filter(Boolean);
    expect(undoTokens).toEqual(['undo-1', 'undo-2']);
    expect(screen.queryByTestId('models-bulk-failed')).not.toBeInTheDocument();
  });

  it('reports failed models and retries only those through a fresh dry run', async () => {
    serveList(twoRows);
    const result: ModelAccessBulkResult = {
      batchId: 'b1',
      results: [
        { id: 'example-text-1', outcome: 'updated' },
        { id: 'example-text-2', outcome: 'failed', reason: 'write-error' },
      ],
      counts: { selected: 2, updated: 1, unchanged: 0, failed: 1 },
      summary: 'Updated 1 of 2. 1 failed',
      undoToken: 'undo-1',
      revision: 'r2',
    };
    post.mockImplementation(async (_url: string, body: { dryRunToken?: string; change: { enabled?: boolean } }) => ({
      data: body.dryRunToken ? result : dryRun({ items: [], counts: { ...dryRun().counts, noAudienceChange: 0 } }),
    }));
    await renderModelsRoute('/admin?tab=models&modelsView=all', ModelListSection);

    await selectPage();
    fireEvent.click(screen.getByTestId('models-bulk-turn-off-btn'));
    await screen.findByTestId('models-bulk-summary');
    expect(bulkBodies()[0]).toEqual({
      selection: { ids: ['example-text-1', 'example-text-2'] },
      change: { enabled: false },
    });
    pickReason('models-bulk-dialog');
    fireEvent.click(screen.getByTestId('models-bulk-dialog-confirm-btn'));

    const failed = await screen.findByTestId('models-bulk-failed');
    expect(failed).toHaveTextContent('Updated 1 of 2. 1 failed');
    expect(failed).toHaveTextContent('example-text-2: the write failed');

    fireEvent.click(screen.getByTestId('models-bulk-retry-btn'));
    await waitFor(() =>
      expect(bulkBodies().at(-1)).toEqual({ selection: { ids: ['example-text-2'] }, change: { enabled: false } })
    );
  });

  it('dismisses the failed-models report', async () => {
    serveList(twoRows);
    const result: ModelAccessBulkResult = {
      batchId: 'b1',
      results: [{ id: 'example-text-2', outcome: 'failed', reason: 'write-error' }],
      counts: { selected: 2, updated: 0, unchanged: 1, failed: 1 },
      summary: 'Updated 0 of 1. 1 failed',
      undoToken: null,
      revision: null,
    };
    post.mockImplementation(async (_url: string, body: { dryRunToken?: string }) => ({
      data: body.dryRunToken ? result : dryRun(),
    }));
    await renderModelsRoute('/admin?tab=models&modelsView=all', ModelListSection);

    await selectPage();
    fireEvent.click(screen.getByTestId('models-bulk-turn-off-btn'));
    await screen.findByTestId('models-bulk-summary');
    pickReason('models-bulk-dialog');
    fireEvent.click(screen.getByTestId('models-bulk-dialog-confirm-btn'));

    await screen.findByTestId('models-bulk-failed');
    fireEvent.click(screen.getByTestId('models-bulk-failed-dismiss-btn'));
    expect(screen.queryByTestId('models-bulk-failed')).not.toBeInTheDocument();
  });

  it('retries a failed preview', async () => {
    serveList(twoRows);
    post.mockRejectedValueOnce(apiFailure(500, { error: 'Preview store is down' }));
    post.mockResolvedValue({ data: dryRun() });
    await renderModelsRoute('/admin?tab=models&modelsView=all', ModelListSection);

    await selectPage();
    fireEvent.click(screen.getByTestId('models-bulk-turn-off-btn'));
    expect(await screen.findByTestId('models-bulk-preview-error')).toHaveTextContent('Preview store is down');

    fireEvent.click(screen.getByTestId('models-bulk-preview-retry-btn'));
    expect(await screen.findByTestId('models-bulk-summary')).toHaveTextContent('Turn off: 2 change');
    expect(bulkBodies()).toHaveLength(2);
  });

  it('swaps in the fresh dry run a 409 carries and asks for a second look', async () => {
    serveList(twoRows);
    const fresh = dryRun({ token: 'token-2', counts: { ...dryRun().counts, change: 1, unchanged: 1 } });
    post.mockImplementation(async (_url: string, body: { dryRunToken?: string }) => {
      if (body.dryRunToken) throw apiFailure(409, { error: 'Access changed', dryRun: fresh });
      return { data: dryRun({ items: [], counts: { ...dryRun().counts, noAudienceChange: 0 } }) };
    });
    await renderModelsRoute('/admin?tab=models&modelsView=all', ModelListSection);

    await selectPage();
    fireEvent.click(screen.getByTestId('models-bulk-turn-on-btn'));
    await screen.findByTestId('models-bulk-summary');
    pickReason('models-bulk-dialog');
    fireEvent.click(screen.getByTestId('models-bulk-dialog-confirm-btn'));

    expect(await screen.findByTestId('models-bulk-stale')).toBeInTheDocument();
    expect(screen.getByTestId('models-bulk-summary')).toHaveTextContent('Turn on: 1 change, 1 already on');
  });

  it('requires a confirm before leaving models visible to admins only', async () => {
    serveList(twoRows);
    post.mockResolvedValue({
      data: dryRun({ adminOnlyIds: ['example-text-1'], counts: { ...dryRun().counts, adminOnly: 1 } }),
    });
    await renderModelsRoute('/admin?tab=models&modelsView=all', ModelListSection);

    await selectPage();
    fireEvent.click(screen.getByTestId('models-bulk-remove-entitlement-btn'));
    const input = screen.getByTestId('models-bulk-values-input');
    fireEvent.change(input, { target: { value: 'base' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(await screen.findByTestId('models-bulk-admin-only')).toHaveTextContent('example-text-1');
    pickReason('models-bulk-dialog');
    expect(screen.getByTestId('models-bulk-dialog-confirm-btn')).toBeDisabled();
    fireEvent.click(screen.getByTestId('models-bulk-admin-only-checkbox'));
    expect(screen.getByTestId('models-bulk-dialog-confirm-btn')).not.toBeDisabled();
  });

  it('drops the server admins-only list once the change it was for is edited', async () => {
    serveList(twoRows);
    post.mockImplementation(async (_url: string, body: { dryRunToken?: string }) => {
      if (body.dryRunToken) throw apiFailure(422, { error: 'Only admins', adminOnlyIds: ['example-text-1'] });
      return { data: dryRun() };
    });
    await renderModelsRoute('/admin?tab=models&modelsView=all', ModelListSection);

    await selectPage();
    fireEvent.click(screen.getByTestId('models-bulk-remove-entitlement-btn'));
    const input = screen.getByTestId('models-bulk-values-input');
    fireEvent.change(input, { target: { value: 'pro' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await screen.findByTestId('models-bulk-summary');
    pickReason('models-bulk-dialog');
    fireEvent.click(screen.getByTestId('models-bulk-dialog-confirm-btn'));
    expect(await screen.findByTestId('models-bulk-admin-only')).toHaveTextContent('example-text-1');

    fireEvent.change(input, { target: { value: 'team' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.queryByTestId('models-bulk-admin-only')).not.toBeInTheDocument());
    expect(screen.queryByTestId('models-bulk-apply-error')).not.toBeInTheDocument();
  });

  it('drops the server admins-only list once a fresh dry run replaces the one it was for', async () => {
    serveList(twoRows);
    const fresh = dryRun({ token: 'token-2', counts: { ...dryRun().counts, change: 1, unchanged: 1 } });
    let applies = 0;
    post.mockImplementation(async (_url: string, body: { dryRunToken?: string }) => {
      if (!body.dryRunToken) return { data: dryRun() };
      applies += 1;
      if (applies === 1) throw apiFailure(422, { error: 'Only admins', adminOnlyIds: ['example-text-1'] });
      throw apiFailure(409, { error: 'Access changed', dryRun: fresh });
    });
    await renderModelsRoute('/admin?tab=models&modelsView=all', ModelListSection);

    await selectPage();
    fireEvent.click(screen.getByTestId('models-bulk-turn-on-btn'));
    await screen.findByTestId('models-bulk-summary');
    pickReason('models-bulk-dialog');
    fireEvent.click(screen.getByTestId('models-bulk-dialog-confirm-btn'));
    expect(await screen.findByTestId('models-bulk-admin-only')).toHaveTextContent('example-text-1');
    fireEvent.click(screen.getByTestId('models-bulk-admin-only-checkbox'));
    fireEvent.click(screen.getByTestId('models-bulk-dialog-confirm-btn'));

    expect(await screen.findByTestId('models-bulk-stale')).toBeInTheDocument();
    expect(screen.queryByTestId('models-bulk-admin-only')).not.toBeInTheDocument();
    expect(screen.getByTestId('models-bulk-dialog-confirm-btn')).not.toBeDisabled();
  });

  it('suggests tags set only on model access entries alongside the tags users hold', async () => {
    get.mockImplementation(async (url: string) => {
      if (url === '/api/admin/models') return { data: twoRows() };
      if (url === '/api/admin/users/tags') return { data: { tags: [{ tag: 'beta', count: 37 }] } };
      if (url === '/api/admin/llm-models/configurations') {
        return {
          data: { settingValue: [{ id: 'another-model', enabled: true, allowedUserTags: ['legacy'] }] },
          headers: {},
        };
      }
      throw new Error(`unexpected GET ${url}`);
    });
    post.mockResolvedValue({ data: dryRun() });
    await renderModelsRoute('/admin?tab=models&modelsView=all', ModelListSection);

    await selectPage();
    fireEvent.click(screen.getByTestId('models-bulk-remove-tag-btn'));
    const input = screen.getByTestId('models-bulk-values-input');
    fireEvent.mouseDown(input);
    fireEvent.change(input, { target: { value: 'leg' } });

    expect(await screen.findByRole('option', { name: 'legacy' })).toBeInTheDocument();
  });

  it('explains a filter that matches more models than one bulk change covers', async () => {
    serveList(twoRows);
    post.mockRejectedValue(apiFailure(422, { error: 'Too many', matched: 612 }));
    await renderModelsRoute('/admin?tab=models&modelsView=all', ModelListSection);

    await selectPage();
    fireEvent.click(screen.getByTestId('admin-select-all-matching-btn'));
    fireEvent.click(screen.getByTestId('models-bulk-turn-on-btn'));

    expect(await screen.findByTestId('models-bulk-selection-error')).toHaveTextContent('612 models');
  });
});
