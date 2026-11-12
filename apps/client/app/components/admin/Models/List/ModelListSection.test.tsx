import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  MODEL_ACCESS_UNDO_EXPIRED_CODE,
  type ModelAccessBulkDryRun,
  type ModelAccessBulkResult,
} from '@bike4mind/common';
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

import { toast } from 'sonner';
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
    if (url === '/api/admin/llm-models/configurations') return { data: { settingValue: [] }, headers: {} };
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

const deferred = () => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>(done => (resolve = done));
  return { promise, resolve };
};

beforeEach(() => {
  vi.mocked(toast).mockClear();
  vi.mocked(toast.error).mockClear();
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

  /** Needs review holds `count` models; All holds both rows. */
  const serveReviewCount = (count: { current: number }) =>
    serveList(view =>
      listResponse(view === 'needs-review' ? (count.current > 0 ? [reviewRow] : []) : [listedRow, reviewRow], {
        viewCounts: { 'needs-review': count.current, all: 2 },
      })
    );

  it('keeps All, and the selection, when a refetch finds models needing review after it opened', async () => {
    const needsReview = { current: 0 };
    serveReviewCount(needsReview);
    const { router, queryClient } = await renderModelsRoute('/admin?tab=models', ModelListSection);
    await screen.findByTestId('models-row-example-text-1');
    expect(screen.getByTestId('models-view-all')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(screen.getByTestId('admin-table-select-example-text-1')).getByRole('checkbox'));
    expect(screen.getByTestId('admin-bulk-action-bar')).toHaveTextContent('1 selected');

    needsReview.current = 3;
    await act(() => queryClient.invalidateQueries());
    await waitFor(() => expect(screen.getByTestId('models-views-needs-review-count')).toHaveTextContent('3'));

    expect(screen.getByTestId('models-view-all')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('admin-bulk-action-bar')).toHaveTextContent('1 selected');
    expect(listCalls().at(-1)?.view).toBe('all');
    expect(router.state.location.search).not.toHaveProperty('modelsView');
  });

  it('keeps Needs review when a refetch finds it empty after it opened', async () => {
    const needsReview = { current: 1 };
    serveReviewCount(needsReview);
    const { router, queryClient } = await renderModelsRoute('/admin?tab=models', ModelListSection);
    await screen.findByTestId('models-row-example-text-2');

    needsReview.current = 0;
    await act(() => queryClient.invalidateQueries());
    await waitFor(() => expect(screen.getByTestId('models-views-needs-review-count')).toHaveTextContent('0'));

    expect(screen.getByTestId('models-view-needs-review')).toHaveAttribute('aria-pressed', 'true');
    expect(listCalls().some(params => params.view === 'all')).toBe(false);
    expect(router.state.location.search).not.toHaveProperty('modelsView');
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

  it('shows each sunset date with the days left, overdue included', async () => {
    serveList(() =>
      listResponse([
        modelRow({ id: 'soon', name: 'Soon', sunsetDate: '2026-12-01', sunsetDays: 20 }),
        modelRow({ id: 'today', name: 'Today', sunsetDate: '2026-11-11', sunsetDays: 0 }),
        modelRow({ id: 'past', name: 'Past', sunsetDate: '2026-10-25', sunsetDays: -17 }),
        modelRow({ id: 'undated', name: 'Undated', price: null }),
      ])
    );
    await renderModelsRoute('/admin?tab=models&modelsView=all', ModelListSection);

    const sunsetOf = (id: string) => within(screen.getByTestId(`models-row-${id}`)).queryByTestId('models-row-sunset');
    await screen.findByTestId('models-row-soon');
    expect(sunsetOf('soon')).toHaveTextContent('2026-12-01in 20 days');
    expect(sunsetOf('today')).toHaveTextContent('2026-11-11today');
    expect(sunsetOf('past')).toHaveTextContent('2026-10-2517 days ago');
    expect(sunsetOf('undated')).not.toBeInTheDocument();
    expect(within(screen.getByTestId('models-row-undated')).getAllByTestId('models-row-empty')).toHaveLength(2);
    expect(within(screen.getByTestId('models-row-soon')).queryByTestId('models-row-empty')).not.toBeInTheDocument();
  });

  it('opens the Retiring view sorted by sunset, most overdue first', async () => {
    serveList(() => listResponse([listedRow]));
    await renderModelsRoute('/admin?tab=models&modelsView=retiring', ModelListSection);

    await screen.findByTestId('models-row-example-text-1');
    expect(listCalls().at(-1)).toMatchObject({ view: 'retiring', sort: 'sunset' });
    expect(screen.getByTestId('admin-table-sort-sunset-btn').closest('th')).toHaveAttribute('aria-sort', 'ascending');
  });

  it('drops the last view sort when the Retiring view is opened', async () => {
    serveList(() => listResponse([listedRow]));
    const { router } = await renderModelsRoute(
      '/admin?tab=models&modelsView=all&modelsSort=rank&modelsDir=desc',
      ModelListSection
    );

    await screen.findByTestId('models-row-example-text-1');
    fireEvent.click(screen.getByTestId('models-view-retiring'));

    await waitFor(() => expect(listCalls().at(-1)).toMatchObject({ view: 'retiring', sort: 'sunset' }));
    expect(listCalls().at(-1)?.dir).toBeUndefined();
    expect(router.state.location.search).not.toHaveProperty('modelsSort');
    expect(router.state.location.search).not.toHaveProperty('modelsDir');
  });

  it('shows a sunset sort from the URL on the Retires header in any view', async () => {
    serveList(() => listResponse([listedRow]));
    await renderModelsRoute('/admin?tab=models&modelsView=all&modelsSort=sunset&modelsDir=desc', ModelListSection);

    await screen.findByTestId('models-row-example-text-1');
    expect(listCalls().at(-1)).toMatchObject({ view: 'all', sort: 'sunset', dir: 'desc' });
    const header = screen.getByTestId('admin-table-sort-sunset-btn');
    expect(header.closest('th')).toHaveAttribute('aria-sort', 'descending');
    expect(header).toHaveTextContent('Retires');
  });

  it('sorts by sunset from the Retires header, ascending first', async () => {
    serveList(() => listResponse([listedRow]));
    const { router } = await renderModelsRoute('/admin?tab=models&modelsView=all', ModelListSection);

    await screen.findByTestId('models-row-example-text-1');
    fireEvent.click(screen.getByTestId('admin-table-sort-sunset-btn'));

    await waitFor(() => expect(router.state.location.search).toMatchObject({ modelsSort: 'sunset', modelsDir: 'asc' }));
    await waitFor(() => expect(listCalls().at(-1)).toMatchObject({ sort: 'sunset', dir: 'asc' }));
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

  it("opens the change's audit entry in a new tab, so the toast keeps its Undo", async () => {
    serveList(() => listResponse([listedRow]));
    patch.mockResolvedValue({ data: { entry: null, changed: true, revision: 'r2' } });
    await renderModelsRoute('/admin?tab=models&modelsView=all', ModelListSection);

    fireEvent.click(within(await screen.findByTestId('models-row-example-text-1')).getByTestId('models-row-menu-btn'));
    fireEvent.click(await screen.findByTestId('models-row-toggle-item'));
    pickReason('model-access-dialog');
    fireEvent.click(screen.getByTestId('model-access-dialog-confirm-btn'));

    const audit = await screen.findByTestId('undo-toast-audit-btn');
    expect(audit.tagName).toBe('A');
    expect(audit).toHaveAttribute('href', '/admin/models/example-text-1?tab=admin');
    expect(audit).toHaveAttribute('target', '_blank');
    expect(audit).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByTestId('undo-toast-undo-btn')).toBeInTheDocument();
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

  it('keeps a blocked Open key settings action in a row from opening the model', async () => {
    user.current = { isAdmin: false, adminPermissions: ['support:read'] };
    const keyRow = modelRow({
      status: 'hidden',
      reasons: [{ code: 'no-credential', message: 'No API key', fixAction: 'open-key-settings' }],
    });
    serveList(() => listResponse([keyRow]));
    const { router } = await renderModelsRoute('/admin?tab=models&modelsView=all', ModelListSection);

    const fix = within(await screen.findByTestId('models-row-example-text-1')).getByTestId('models-row-fix-btn');
    expect(fix).toBeDisabled();
    fireEvent.click(screen.getByTestId('models-tab-blocked-action'));
    await act(() => new Promise(resolve => setTimeout(resolve, 50)));

    expect(router.state.location.pathname).toBe('/admin');
    expect(router.state.location.search).not.toMatchObject({ tab: 'admin-settings' });
    expect(screen.queryByTestId('probe-detail')).not.toBeInTheDocument();
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

describe('ModelListSection for a delegate', () => {
  it('reads only the model list and leaves row selection and bulk writes disabled', async () => {
    user.current = { isAdmin: false, adminPermissions: ['support:read'] };
    serveList(() => listResponse([listedRow]));
    await renderModelsRoute('/admin?tab=models&modelsView=all', ModelListSection);

    const checkbox = within(await screen.findByTestId('admin-table-select-example-text-1')).getByRole('checkbox');
    expect(checkbox).toBeDisabled();
    expect(within(screen.getByTestId('admin-table-select-page')).getByRole('checkbox')).toBeDisabled();
    expect([...new Set(get.mock.calls.map(([url]) => url))]).toEqual(['/api/admin/models']);
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
    expect(toast).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  const partlyApplied: ModelAccessBulkResult = {
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
  const retryApplied: ModelAccessBulkResult = {
    batchId: 'b2',
    results: [{ id: 'example-text-2', outcome: 'updated' }],
    counts: { selected: 1, updated: 1, unchanged: 0, failed: 0 },
    summary: 'Updated 1 of 1',
    undoToken: 'undo-2',
    revision: 'r3',
  };
  const undoExpired = () =>
    apiFailure(409, {
      error: 'This undo has expired. Change the models back from the list.',
      code: MODEL_ACCESS_UNDO_EXPIRED_CODE,
    });
  const undoneOne = (id: string): { data: ModelAccessBulkResult } => ({
    data: {
      batchId: `undo-${id}`,
      results: [{ id, outcome: 'updated' }],
      counts: { selected: 1, updated: 1, unchanged: 0, failed: 0 },
      summary: 'Updated 1 of 1',
      undoToken: null,
      revision: 'r4',
    },
  });
  const undoTokensSent = () =>
    bulkBodies()
      .map(body => (body as { undoToken?: string }).undoToken)
      .filter(Boolean);
  const serveBulk = (undo: (token: string) => Promise<{ data: ModelAccessBulkResult }>) => {
    let applies = 0;
    post.mockImplementation(async (_url: string, body: { dryRunToken?: string; undoToken?: string }) => {
      if (body.undoToken) return undo(body.undoToken);
      if (body.dryRunToken) return { data: (applies += 1) === 1 ? partlyApplied : retryApplied };
      return { data: dryRun() };
    });
  };
  const confirmBulk = async () => {
    await screen.findByTestId('models-bulk-summary');
    pickReason('models-bulk-dialog');
    await waitFor(() => expect(screen.getByTestId('models-bulk-dialog-confirm-btn')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('models-bulk-dialog-confirm-btn'));
  };
  /** A turn-off that fails one model, then its retry: one toast whose Undo covers both writes. */
  const applyThenRetry = async () => {
    const rendered = await renderModelsRoute('/admin?tab=models&modelsView=all', ModelListSection);
    await selectPage();
    fireEvent.click(screen.getByTestId('models-bulk-turn-off-btn'));
    await confirmBulk();
    fireEvent.click(await screen.findByTestId('models-bulk-retry-btn'));
    await confirmBulk();
    await waitFor(() => expect(screen.getByTestId('undo-toast-message')).toHaveTextContent('Updated 1 of 1'));
    return rendered;
  };

  it('reports what an undo reverted before it failed, refreshes the list, and resumes at the unsent token', async () => {
    serveList(twoRows);
    let secondUndoTries = 0;
    serveBulk(async token => {
      if (token === 'undo-1') return undoneOne('example-text-1');
      if ((secondUndoTries += 1) === 1) throw apiFailure(422, { error: 'Access store unavailable' });
      return undoneOne('example-text-2');
    });
    await applyThenRetry();
    const listReads = listCalls().length;

    fireEvent.click(screen.getByTestId('undo-toast-undo-btn'));
    const stopped = 'Undo: 1 model reverted; the rest failed: Access store unavailable';
    expect(await screen.findByTestId('undo-toast-error')).toHaveTextContent(stopped);
    const report = screen.getByTestId('models-bulk-failed');
    expect(report).toHaveTextContent(`${stopped}. Retry 1 (1 model) was not undone yet.`);
    expect(screen.getByTestId('models-bulk-not-undone-item')).toHaveTextContent('Retry 1: example-text-2');
    expect(report).toHaveTextContent('Undo again from the undo toast while it is open.');
    expect(report).toHaveTextContent("Once it has closed, change these back from each model's page.");
    expect(screen.queryByTestId('models-bulk-retry-btn')).not.toBeInTheDocument();
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(listReads));

    fireEvent.click(screen.getByTestId('undo-toast-undo-btn'));
    await waitFor(() => expect(screen.getByTestId('undo-toast-message')).toHaveTextContent('Undo: 2 models reverted.'));
    expect(undoTokensSent()).toEqual(['undo-1', 'undo-2', 'undo-2']);
    expect(screen.queryByTestId('models-bulk-failed')).not.toBeInTheDocument();
  });

  const stopUndoWith = async (failure: Error) => {
    serveList(twoRows);
    serveBulk(async token => {
      if (token === 'undo-1') return undoneOne('example-text-1');
      throw failure;
    });
    await applyThenRetry();
    fireEvent.click(screen.getByTestId('undo-toast-undo-btn'));
    await screen.findByTestId('undo-toast-error');
    return screen.getByTestId('models-bulk-failed');
  };

  it.each([
    ['a 5xx', apiFailure(503, { error: 'Access store unavailable' })],
    ['a network error', Object.assign(new Error('Network Error'), { isAxiosError: true })],
  ])('says a write may not have been undone when its undo POST failed with %s', async (_name, failure) => {
    const report = await stopUndoWith(failure);
    expect(report).toHaveTextContent("Retry 1 (1 model) may not have been undone; check each model's page.");
    expect(report).not.toHaveTextContent('was not undone');
  });

  it('says a write was not undone when its undo POST was refused with a 4xx', async () => {
    const report = await stopUndoWith(apiFailure(403, { error: 'Not allowed' }));
    expect(report).toHaveTextContent('Retry 1 (1 model) was not undone yet.');
    expect(report).not.toHaveTextContent('may not have been undone');
  });

  it('opens the models a stopped undo left in a new tab while the toast can resume it, here once it closes', async () => {
    serveList(twoRows);
    serveBulk(async token => {
      if (token === 'undo-1') return undoneOne('example-text-1');
      throw apiFailure(422, { error: 'Access store unavailable' });
    });
    const { router } = await applyThenRetry();
    fireEvent.click(screen.getByTestId('undo-toast-undo-btn'));
    await screen.findByTestId('undo-toast-error');

    const link = within(screen.getByTestId('models-bulk-failed')).getByTestId('models-bulk-not-undone-link');
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', '/admin/models/example-text-2');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('undo-toast')).not.toBeInTheDocument());
    const inTab = screen.getByTestId('models-bulk-not-undone-link');
    expect(inTab).not.toHaveAttribute('href');
    fireEvent.click(inTab);
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/models/example-text-2'));
  });

  const stampMoved = (id: string): { data: ModelAccessBulkResult } => ({
    data: {
      batchId: `undo-${id}`,
      results: [{ id, outcome: 'failed', reason: 'stamp-moved' }],
      counts: { selected: 1, updated: 0, unchanged: 0, failed: 1 },
      summary: 'Updated 0 of 1. 1 failed',
      undoToken: null,
      revision: 'r4',
    },
  });

  it('calls a resend after an unconfirmed failure unconfirmed, not changed since the batch', async () => {
    serveList(twoRows);
    let firstTries = 0;
    serveBulk(async token => {
      if (token === 'undo-1') {
        if ((firstTries += 1) === 1) throw apiFailure(503, { error: 'Access store unavailable' });
        return stampMoved('example-text-1');
      }
      return undoneOne('example-text-2');
    });
    await applyThenRetry();

    fireEvent.click(screen.getByTestId('undo-toast-undo-btn'));
    await screen.findByTestId('undo-toast-error');
    expect(screen.getByTestId('models-bulk-failed')).toHaveTextContent('may not have been undone');
    fireEvent.click(screen.getByTestId('undo-toast-undo-btn'));
    await waitFor(() => expect(undoTokensSent()).toEqual(['undo-1', 'undo-1', 'undo-2']));
    const report = await screen.findByTestId('models-bulk-failed');
    expect(report).toHaveTextContent('Undo: 1 model reverted, 1 unconfirmed.');
    expect(screen.getByTestId('models-bulk-unconfirmed-item')).toHaveTextContent(
      "example-text-1: may already be undone; check each model's page."
    );
    expect(report).not.toHaveTextContent('changed since the batch');
    expect(report).not.toHaveTextContent('not reverted');
  });

  it('calls a write error on a resend after an unconfirmed failure unconfirmed', async () => {
    serveList(twoRows);
    let firstTries = 0;
    serveBulk(async token => {
      if (token === 'undo-1') {
        if ((firstTries += 1) === 1) throw apiFailure(503, { error: 'Access store unavailable' });
        const { data } = stampMoved('example-text-1');
        return { data: { ...data, results: [{ id: 'example-text-1', outcome: 'failed', reason: 'write-error' }] } };
      }
      return undoneOne('example-text-2');
    });
    await applyThenRetry();

    fireEvent.click(screen.getByTestId('undo-toast-undo-btn'));
    await screen.findByTestId('undo-toast-error');
    fireEvent.click(screen.getByTestId('undo-toast-undo-btn'));
    await waitFor(() => expect(undoTokensSent()).toEqual(['undo-1', 'undo-1', 'undo-2']));
    const report = await screen.findByTestId('models-bulk-failed');
    expect(report).toHaveTextContent('Undo: 1 model reverted, 1 unconfirmed.');
    expect(screen.getByTestId('models-bulk-unconfirmed-item')).toHaveTextContent('may already be undone');
    expect(report).not.toHaveTextContent('the write failed');
  });

  it('keeps may not have been undone for an uncertain entry whose resend comes back expired', async () => {
    serveList(twoRows);
    let firstTries = 0;
    serveBulk(async token => {
      if (token === 'undo-1') {
        if ((firstTries += 1) === 1) throw apiFailure(503, { error: 'Access store unavailable' });
        throw undoExpired();
      }
      return undoneOne('example-text-2');
    });
    await applyThenRetry();

    fireEvent.click(screen.getByTestId('undo-toast-undo-btn'));
    await screen.findByTestId('undo-toast-error');
    fireEvent.click(screen.getByTestId('undo-toast-undo-btn'));
    await waitFor(() => expect(undoTokensSent()).toEqual(['undo-1', 'undo-1', 'undo-2']));
    const report = await screen.findByTestId('models-bulk-failed');
    expect(report).toHaveTextContent(
      "The original change (1 model) may not have been undone; check each model's page."
    );
    expect(report).not.toHaveTextContent('was not undone');
  });

  it('stops the undo on any other 409, even one whose message mentions expiry', async () => {
    const report = await stopUndoWith(apiFailure(409, { error: 'The access lock expired; try again.' }));
    expect(screen.getByTestId('undo-toast-error')).toHaveTextContent(
      'Undo: 1 model reverted; the rest failed: The access lock expired; try again.'
    );
    expect(report).toHaveTextContent('Retry 1 (1 model) was not undone yet.');
    expect(report).not.toHaveTextContent('its undo had expired');
  });

  it('gives a model already sent and a write still unsent their own guidance', async () => {
    serveList(twoRows);
    serveBulk(async token => {
      if (token === 'undo-1') return stampMoved('example-text-1');
      throw apiFailure(422, { error: 'Access store unavailable' });
    });
    await applyThenRetry();

    fireEvent.click(screen.getByTestId('undo-toast-undo-btn'));
    await screen.findByTestId('undo-toast-error');
    const report = screen.getByTestId('models-bulk-failed');
    expect(report).toHaveTextContent('example-text-1: changed since the batch');
    expect(within(report).getAllByText("Change these back from each model's page.")).toHaveLength(1);
    expect(
      within(report).getByText("Once it has closed, change these back from each model's page.")
    ).toBeInTheDocument();
    expect(report).toHaveTextContent('Undo again from the undo toast while it is open.');
  });

  it('skips an expired undo, still sends the later one, and names the write that expired with its models', async () => {
    serveList(twoRows);
    serveBulk(async token => {
      if (token === 'undo-1') {
        throw undoExpired();
      }
      return undoneOne('example-text-2');
    });
    const { router } = await applyThenRetry();

    fireEvent.click(screen.getByTestId('undo-toast-undo-btn'));
    const summary = 'Undo: 1 model reverted. The original change (1 model) was not undone: its undo had expired.';
    await waitFor(() => expect(screen.getByTestId('undo-toast-message')).toHaveTextContent(summary));
    expect(undoTokensSent()).toEqual(['undo-1', 'undo-2']);
    const report = screen.getByTestId('models-bulk-failed');
    expect(report).toHaveTextContent(summary);
    expect(screen.getByTestId('models-bulk-not-undone-item')).toHaveTextContent('The original change: example-text-1');
    expect(report).toHaveTextContent("Change these back from each model's page.");
    expect(screen.queryByTestId('undo-toast-error')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('models-bulk-not-undone-link'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/models/example-text-1'));
  });

  it('closes a retry that was open when Undo ran, so nothing can join the batch being reverted', async () => {
    serveList(twoRows);
    serveBulk(async token => undoneOne(token === 'undo-1' ? 'example-text-1' : 'example-text-2'));
    await renderModelsRoute('/admin?tab=models&modelsView=all', ModelListSection);
    await selectPage();
    fireEvent.click(screen.getByTestId('models-bulk-turn-off-btn'));
    await confirmBulk();
    fireEvent.click(await screen.findByTestId('models-bulk-retry-btn'));
    await screen.findByTestId('models-bulk-summary');

    fireEvent.click(screen.getByTestId('undo-toast-undo-btn'));
    await waitFor(() => expect(screen.queryByTestId('models-bulk-dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('undo-toast-message')).toHaveTextContent('Undo: 1 model reverted.'));
    expect(undoTokensSent()).toEqual(['undo-1']);
  });

  it('keeps the failed-models report when a retry is cancelled', async () => {
    serveList(twoRows);
    serveBulk(async token => undoneOne(token === 'undo-1' ? 'example-text-1' : 'example-text-2'));
    await renderModelsRoute('/admin?tab=models&modelsView=all', ModelListSection);
    await selectPage();
    fireEvent.click(screen.getByTestId('models-bulk-turn-off-btn'));
    await confirmBulk();
    fireEvent.click(await screen.findByTestId('models-bulk-retry-btn'));
    await screen.findByTestId('models-bulk-summary');

    fireEvent.click(screen.getByTestId('models-bulk-dialog-cancel-btn'));
    await waitFor(() => expect(screen.queryByTestId('models-bulk-dialog')).not.toBeInTheDocument());
    expect(await screen.findByTestId('models-bulk-retry-btn')).not.toBeDisabled();
  });

  it('disables Retry for a batch while its undo runs', async () => {
    serveList(twoRows);
    const undoGate = deferred();
    serveBulk(async token => {
      await undoGate.promise;
      return undoneOne(token === 'undo-1' ? 'example-text-1' : 'example-text-2');
    });
    await renderModelsRoute('/admin?tab=models&modelsView=all', ModelListSection);
    await selectPage();
    fireEvent.click(screen.getByTestId('models-bulk-turn-off-btn'));
    await confirmBulk();
    const retry = await screen.findByTestId('models-bulk-retry-btn');

    fireEvent.click(screen.getByTestId('undo-toast-undo-btn'));
    await waitFor(() => expect(retry).toBeDisabled());
    fireEvent.click(retry);
    expect(screen.queryByTestId('models-bulk-dialog')).not.toBeInTheDocument();

    await act(async () => undoGate.resolve());
    await waitFor(() => expect(screen.getByTestId('undo-toast-message')).toHaveTextContent('Undo: 1 model reverted.'));
    expect(screen.queryByTestId('models-bulk-failed')).not.toBeInTheDocument();
    expect(undoTokensSent()).toEqual(['undo-1']);
  });

  it('keeps a retry that lands mid-undo on screen with its own undo, and labels its expiry as a retry', async () => {
    serveList(twoRows);
    const undoGate = deferred();
    const retryGate = deferred();
    let applies = 0;
    post.mockImplementation(async (_url: string, body: { dryRunToken?: string; undoToken?: string }) => {
      if (body.undoToken === 'undo-1') {
        await undoGate.promise;
        return undoneOne('example-text-1');
      }
      if (body.undoToken) {
        throw undoExpired();
      }
      if (body.dryRunToken) {
        if ((applies += 1) === 1) return { data: partlyApplied };
        await retryGate.promise;
        return { data: retryApplied };
      }
      return { data: dryRun() };
    });
    await renderModelsRoute('/admin?tab=models&modelsView=all', ModelListSection);
    await selectPage();
    fireEvent.click(screen.getByTestId('models-bulk-turn-off-btn'));
    await confirmBulk();
    fireEvent.click(await screen.findByTestId('models-bulk-retry-btn'));
    await confirmBulk();

    fireEvent.click(screen.getByTestId('undo-toast-undo-btn'));
    await act(async () => retryGate.resolve());
    await waitFor(() => expect(screen.getByTestId('undo-toast-message')).toHaveTextContent('Updated 1 of 1'));
    await act(async () => undoGate.resolve());

    await waitFor(() => expect(toast).toHaveBeenCalledWith('Undo: 1 model reverted.'));
    expect(screen.getByTestId('undo-toast-message')).toHaveTextContent('Updated 1 of 1');
    fireEvent.click(screen.getByTestId('undo-toast-undo-btn'));
    await waitFor(() =>
      expect(screen.getByTestId('undo-toast-message')).toHaveTextContent(
        'Undo: 0 models reverted. Retry 1 (1 model) was not undone: its undo had expired.'
      )
    );
    expect(undoTokensSent()).toEqual(['undo-1', 'undo-2']);
  });

  const appliedWith = (
    summary: string,
    updated: string[],
    failed: string[],
    undoToken: string
  ): ModelAccessBulkResult => ({
    batchId: undoToken,
    results: [
      ...updated.map(id => ({ id, outcome: 'updated' as const })),
      ...failed.map(id => ({ id, outcome: 'failed' as const, reason: 'write-error' as const })),
    ],
    counts: {
      selected: updated.length + failed.length,
      updated: updated.length,
      unchanged: 0,
      failed: failed.length,
    },
    summary,
    undoToken,
    revision: undoToken,
  });
  /**
   * The original apply and retry 1 in one batch, then retry 2 sent before Undo and landing mid-undo in a batch of its
   * own. The batch's undo reverts the original change and fails on retry 1's token.
   */
  const undoStopsBehindRetry = async (applied: ModelAccessBulkResult[]) => {
    const undoGate = deferred();
    const retryGate = deferred();
    let applies = 0;
    post.mockImplementation(async (_url: string, body: { dryRunToken?: string; undoToken?: string }) => {
      if (body.undoToken === 'undo-1') {
        await undoGate.promise;
        return undoneOne('example-text-1');
      }
      if (body.undoToken === 'undo-2') throw apiFailure(422, { error: 'Access store unavailable' });
      if (body.undoToken) return undoneOne('example-text-3');
      if (body.dryRunToken) {
        applies += 1;
        if (applies === 3) await retryGate.promise;
        return { data: applied[applies - 1] };
      }
      return { data: dryRun() };
    });
    const rendered = await renderModelsRoute('/admin?tab=models&modelsView=all', ModelListSection);
    await selectPage();
    fireEvent.click(screen.getByTestId('models-bulk-turn-off-btn'));
    await confirmBulk();
    fireEvent.click(await screen.findByTestId('models-bulk-retry-btn'));
    await confirmBulk();
    await waitFor(() => expect(screen.getByTestId('undo-toast-message')).toHaveTextContent(applied[1].summary));
    fireEvent.click(await screen.findByTestId('models-bulk-retry-btn'));
    await confirmBulk();

    fireEvent.click(screen.getByTestId('undo-toast-undo-btn'));
    await act(async () => retryGate.resolve());
    await waitFor(() => expect(screen.getByTestId('undo-toast-message')).toHaveTextContent(applied[2].summary));
    await act(async () => undoGate.resolve());
    return rendered;
  };
  const stoppedBehindRetry =
    'Undo: 1 model reverted; the rest failed: Access store unavailable. Retry 1 (1 model) was not undone.';

  it('keeps an undo failure off the toast of a retry that landed mid-undo', async () => {
    serveList(twoRows);
    const applied = [
      appliedWith('Updated 1 of 3. 2 failed', ['example-text-1'], ['example-text-2', 'example-text-3'], 'undo-1'),
      appliedWith('Updated 1 of 2. 1 failed', ['example-text-2'], ['example-text-3'], 'undo-2'),
      appliedWith('Updated 1 of 1', ['example-text-3'], [], 'undo-3'),
    ];
    await undoStopsBehindRetry(applied);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(stoppedBehindRetry));
    expect(screen.getByTestId('models-bulk-failed')).toHaveTextContent(stoppedBehindRetry);
    expect(screen.getByTestId('models-bulk-not-undone-item')).toHaveTextContent('Retry 1: example-text-2');
    expect(screen.getByTestId('undo-toast-message')).toHaveTextContent('Updated 1 of 1');
    expect(screen.queryByTestId('undo-toast-error')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('undo-toast-undo-btn'));
    await waitFor(() => expect(screen.getByTestId('undo-toast-message')).toHaveTextContent('Undo: 1 model reverted.'));
    expect(undoTokensSent()).toEqual(['undo-1', 'undo-2', 'undo-3']);
  });

  it('names the models still changed in a notice that stays up when a newer retry holds the panel', async () => {
    serveList(twoRows);
    const { router } = await undoStopsBehindRetry([
      appliedWith(
        'Updated 1 of 4. 3 failed',
        ['example-text-1'],
        ['example-text-2', 'example-text-3', 'example-text-4'],
        'undo-1'
      ),
      appliedWith('Updated 1 of 3. 2 failed', ['example-text-2'], ['example-text-3', 'example-text-4'], 'undo-2'),
      appliedWith('Updated 1 of 2. 1 failed', ['example-text-3'], ['example-text-4'], 'undo-3'),
    ]);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.anything(), { duration: Infinity }));
    const [notice] = vi.mocked(toast.error).mock.calls[0];
    const shown = render(notice as ReactElement);
    expect(shown.getByTestId('models-bulk-undo-notice')).toHaveTextContent(stoppedBehindRetry);
    expect(shown.getByTestId('models-bulk-not-undone-item')).toHaveTextContent('Retry 1: example-text-2');
    expect(shown.getByTestId('models-bulk-undo-notice')).toHaveTextContent("Change these back from each model's page.");

    const panel = screen.getAllByTestId('models-bulk-failed');
    expect(panel).toHaveLength(1);
    expect(panel[0]).toHaveTextContent('Updated 1 of 2. 1 failed');
    expect(panel[0]).not.toHaveTextContent('Retry 1');
    expect(screen.getByTestId('models-bulk-retry-btn')).toBeInTheDocument();
    expect(screen.getByTestId('undo-toast-message')).toHaveTextContent('Updated 1 of 2. 1 failed');
    expect(screen.queryByTestId('undo-toast-error')).not.toBeInTheDocument();

    // The newer retry's toast still offers Undo, so leaving for a model must not drop it.
    const link = shown.getByTestId('models-bulk-not-undone-link');
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', '/admin/models/example-text-2');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(shown.getByTestId('models-bulk-not-undone-link')).not.toHaveAttribute('href'));
    fireEvent.click(shown.getByTestId('models-bulk-not-undone-link'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/models/example-text-2'));
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

  it('says in place when the tag choices fail to load, and asks again on Retry', async () => {
    let failEntries = true;
    get.mockImplementation(async (url: string) => {
      if (url === '/api/admin/models') return { data: twoRows() };
      if (url === '/api/admin/users/tags') return { data: { tags: [{ tag: 'beta', count: 37 }] } };
      if (url === '/api/admin/llm-models/configurations') {
        if (failEntries) throw apiFailure(500, { error: 'down' });
        return { data: { settingValue: [] }, headers: {} };
      }
      throw new Error(`unexpected GET ${url}`);
    });
    post.mockResolvedValue({ data: dryRun() });
    await renderModelsRoute('/admin?tab=models&modelsView=all', ModelListSection);

    await selectPage();
    fireEvent.click(screen.getByTestId('models-bulk-add-tag-btn'));
    expect(await screen.findByTestId('models-bulk-tags-error')).toHaveTextContent('Could not load the existing tags');
    failEntries = false;
    fireEvent.click(screen.getByTestId('models-bulk-tags-error-retry-btn'));

    await waitFor(() => expect(screen.queryByTestId('models-bulk-tags-error')).not.toBeInTheDocument());
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
