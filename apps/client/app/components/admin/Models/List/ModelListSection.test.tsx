import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ModelAccessBulkDryRun, ModelAccessBulkResult } from '@bike4mind/common';
import { apiFailure, listResponse, modelRow, renderModelsRoute } from '../modelsTestUtils';

const { get, post, patch, user } = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  user: { current: { isAdmin: true } as Record<string, unknown> },
}));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get, post, patch } }));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: user.current }) }));

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
afterEach(cleanup);

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
