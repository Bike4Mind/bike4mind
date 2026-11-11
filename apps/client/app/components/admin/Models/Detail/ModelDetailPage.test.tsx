import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { apiFailure, listResponse, modelRow, renderModelsRoute } from '../modelsTestUtils';
import { isModelDetailTab, type ModelDetailTab } from '../modelDetailSearch';
import { useModelsNavigation } from '../modelsNavigation';
import { ADMIN_MODEL_LOGS_TAB_SLUG, ADMIN_MODEL_METRICS_TAB_SLUG } from '../../adminTabParams';
import { MODEL_LOGS_MODEL_PARAM } from '../../modelLogsTabSearch';
import { MODEL_METRICS_SEARCH_KEYS } from '../../ModelMetrics/modelMetricsSearch';

const { get, patch, user } = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
  user: { current: { isAdmin: true } as Record<string, unknown> },
}));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get, patch, post: vi.fn() } }));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: user.current }) }));

import { ModelDetailPage } from './ModelDetailPage';

const IMAGE_ID = 'local-image/anime/foo v2.safetensors';
const BEDROCK_ID = 'us.vendor.example-text-2-v1:0';

const offRow = modelRow({
  id: BEDROCK_ID,
  name: 'Example Text 2 (US)',
  status: 'hidden',
  access: {
    entry: {
      enabled: false,
      allowedUserTags: ['beta'],
      allowedEntitlements: ['base'],
      updatedAt: '2026-11-03T00:00:00.000Z',
    },
    everyone: true,
    adminsOnly: false,
    freeTierLocked: false,
  },
  reasons: [{ code: 'admin-off', message: 'Turned off by an admin', fixAction: 'turn-on' }],
});

const auditEntry = (id: string, at: string, summary: string) => ({
  id,
  source: 'admin',
  occurredAt: at,
  action: 'settings.update',
  category: 'settings',
  severity: 'info',
  actor: { id: 'admin-1', name: 'Admin One' },
  target: { kind: 'settings', id },
  summary,
  context: { source: 'console' },
});

const serve = (
  rows: ReturnType<typeof modelRow>[],
  audit: Record<string, unknown[]> = {},
  entries: { id: string; enabled: boolean; allowedUserTags: string[] }[] = []
) =>
  get.mockImplementation(async (url: string, config?: { params?: Record<string, string> }) => {
    if (url === '/api/admin/models') {
      const search = config?.params?.search ?? '';
      return { data: listResponse(rows.filter(row => row.id.startsWith(search))) };
    }
    if (url === '/api/admin/audit-log') {
      return { data: { entries: audit[config?.params?.targetId ?? ''] ?? [], nextCursor: null } };
    }
    if (url === '/api/admin/users/tags') return { data: { tags: [{ tag: 'beta', count: 4 }] } };
    if (url === '/api/admin/llm-models/configurations') return { data: { settingValue: entries }, headers: {} };
    throw new Error(`unexpected GET ${url}`);
  });

function DetailRoute() {
  const { _splat: modelId = '' } = useParams({ strict: false }) as { _splat?: string };
  const search = useSearch({ strict: false }) as { tab?: string };
  const navigate = useNavigate();
  const tab: ModelDetailTab = isModelDetailTab(search.tab) ? search.tab : 'overview';
  return (
    <ModelDetailPage
      modelId={modelId}
      tab={tab}
      onTabChange={next => void navigate({ to: '/admin/models/$', params: { _splat: modelId }, search: { tab: next } })}
    />
  );
}

function OpenButtons() {
  const { openModel } = useModelsNavigation();
  return (
    <>
      <button data-testid="open-image" onClick={() => void openModel(IMAGE_ID)} />
      <button data-testid="open-bedrock" onClick={() => void openModel(BEDROCK_ID, 'access')} />
    </>
  );
}

beforeEach(() => {
  get.mockReset();
  patch.mockReset();
  user.current = { isAdmin: true };
});
afterEach(cleanup);

describe('model detail route', () => {
  it.each([
    ['open-image', IMAGE_ID, ''],
    ['open-bedrock', BEDROCK_ID, 'access'],
  ])('opens %s at its own id and the URL round-trips', async (button, id, tab) => {
    const { router } = await renderModelsRoute('/admin?tab=models', OpenButtons);
    fireEvent.click(screen.getByTestId(button));

    const probe = await screen.findByTestId('probe-detail');
    expect(probe).toHaveAttribute('data-id', id);
    expect(probe).toHaveAttribute('data-tab', tab);

    await router.navigate({ href: router.state.location.href });
    await waitFor(() => expect(screen.getByTestId('probe-detail')).toHaveAttribute('data-id', id));
  });
});

describe('ModelDetailPage', () => {
  it('says so when no model has the id', async () => {
    serve([]);
    await renderModelsRoute('/admin/models/missing-model', () => null, { Detail: DetailRoute });

    const notFound = await screen.findByTestId('model-detail-not-found');
    expect(notFound).toHaveTextContent('No model with id missing-model');
    fireEvent.click(screen.getByTestId('model-detail-not-found-back-btn'));
    await waitFor(() => expect(screen.queryByTestId('model-detail-not-found')).not.toBeInTheDocument());
  });

  it('shows the status, the reason with its fix action and the access summary', async () => {
    serve([offRow]);
    await renderModelsRoute(`/admin/models/${BEDROCK_ID}`, () => null, { Detail: DetailRoute });

    expect(await screen.findByTestId('model-detail-status')).toHaveTextContent('Hidden');
    expect(screen.getByTestId('model-detail-reason')).toHaveTextContent('Turned off by an admin');
    expect(screen.getByTestId('model-detail-fix-btn')).toHaveTextContent('Turn on');
    expect(screen.getByTestId('model-detail-toggle-btn')).toHaveTextContent('Turn on');
  });

  it('links Usage and Logs from the header meta line and keeps Turn on as the only action', async () => {
    serve([offRow]);
    const { router } = await renderModelsRoute(`/admin/models/${BEDROCK_ID}`, () => null, { Detail: DetailRoute });

    const metaLine = (await screen.findByTestId('model-detail-meta')).parentElement!;
    const usage = within(metaLine).getByTestId('model-detail-usage-link');
    expect(within(metaLine).getByTestId('model-detail-logs-link')).toHaveTextContent('Logs');
    expect(within(metaLine).queryByTestId('model-detail-toggle-btn')).not.toBeInTheDocument();
    expect(screen.getByTestId('model-detail-toggle-btn')).toHaveTextContent('Turn on');

    fireEvent.click(usage);
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({
        tab: ADMIN_MODEL_METRICS_TAB_SLUG,
        [MODEL_METRICS_SEARCH_KEYS.filters.model]: BEDROCK_ID,
      })
    );

    await router.navigate({ to: '/admin/models/$', params: { _splat: BEDROCK_ID } });
    fireEvent.click(await screen.findByTestId('model-detail-logs-link'));
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({
        tab: ADMIN_MODEL_LOGS_TAB_SLUG,
        [MODEL_LOGS_MODEL_PARAM]: BEDROCK_ID,
      })
    );
  });

  it('turns the model on from the fix action, sending the stamp it read', async () => {
    serve([offRow]);
    patch.mockResolvedValue({ data: { entry: null, changed: true, revision: 'r3' } });
    await renderModelsRoute(`/admin/models/${BEDROCK_ID}`, () => null, { Detail: DetailRoute });

    fireEvent.click(await screen.findByTestId('model-detail-fix-btn'));
    fireEvent.click(screen.getByTestId('model-access-dialog-reason-input-preset-0'));
    fireEvent.click(screen.getByTestId('model-access-dialog-confirm-btn'));

    await waitFor(() =>
      expect(patch).toHaveBeenCalledWith(
        '/api/admin/models/access',
        expect.objectContaining({ change: { enabled: true }, expectedUpdatedAt: '2026-11-03T00:00:00.000Z' }),
        { params: { id: BEDROCK_ID } }
      )
    );
  });

  it('keeps an open toggle on the row it opened with when the row refetches', async () => {
    serve([offRow]);
    patch.mockResolvedValue({ data: { entry: null, changed: true, revision: 'r3' } });
    const { queryClient } = await renderModelsRoute(`/admin/models/${BEDROCK_ID}`, () => null, {
      Detail: DetailRoute,
    });

    fireEvent.click(await screen.findByTestId('model-detail-fix-btn'));
    const turnedOnElsewhere = modelRow({
      ...offRow,
      access: {
        ...offRow.access,
        entry: { ...offRow.access.entry!, enabled: true, updatedAt: '2026-11-04T00:00:00.000Z' },
      },
    });
    serve([turnedOnElsewhere]);
    await queryClient.invalidateQueries();
    await waitFor(() => expect(screen.getByTestId('model-detail-toggle-btn')).toHaveTextContent('Turn off'));

    expect(screen.getByTestId('model-access-dialog-confirm-btn')).toHaveTextContent('Turn on');
    fireEvent.click(screen.getByTestId('model-access-dialog-reason-input-preset-0'));
    fireEvent.click(screen.getByTestId('model-access-dialog-confirm-btn'));
    await waitFor(() =>
      expect(patch.mock.calls[0][1]).toMatchObject({
        change: { enabled: true },
        expectedUpdatedAt: '2026-11-03T00:00:00.000Z',
      })
    );
  });

  it('offers tags set only on model access entries in the tag picker', async () => {
    serve([offRow], {}, [{ id: 'another-model', enabled: true, allowedUserTags: ['legacy'] }]);
    await renderModelsRoute(`/admin/models/${BEDROCK_ID}?tab=access`, () => null, { Detail: DetailRoute });

    fireEvent.click(await screen.findByTestId('model-access-audience-btn'));
    const input = screen.getByTestId('model-access-tags-input');
    fireEvent.mouseDown(input);
    fireEvent.change(input, { target: { value: 'leg' } });

    expect(await screen.findByRole('option', { name: 'legacy' })).toBeInTheDocument();
  });

  it('edits tags on the Access tab as one change, previewed before and after', async () => {
    serve([offRow]);
    patch.mockResolvedValue({ data: { entry: null, changed: true, revision: 'r3' } });
    await renderModelsRoute(`/admin/models/${BEDROCK_ID}?tab=access`, () => null, { Detail: DetailRoute });

    expect(await screen.findByTestId('model-access-tags')).toHaveTextContent('beta');
    fireEvent.click(screen.getByTestId('model-access-audience-btn'));
    const input = screen.getByTestId('model-access-tags-input');
    fireEvent.change(input, { target: { value: 'pilot' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(screen.getByTestId('model-access-preview')).toHaveTextContent('Tags: beta');
    expect(screen.getByTestId('model-access-preview')).toHaveTextContent('Tags: beta, pilot');
    fireEvent.click(screen.getByTestId('model-access-dialog-reason-input-preset-0'));
    fireEvent.click(screen.getByTestId('model-access-dialog-confirm-btn'));

    await waitFor(() =>
      expect(patch.mock.calls[0][1]).toMatchObject({ change: { allowedUserTags: ['beta', 'pilot'] } })
    );
  });

  it('asks for confirmation when removing every tag and entitlement would leave the model to admins', async () => {
    const onRow = modelRow({ id: 'only-one', name: 'Only one' });
    serve([onRow]);
    patch
      .mockRejectedValueOnce(apiFailure(422, { error: 'Only admins will see this model. Confirm to continue.' }))
      .mockResolvedValue({ data: { entry: null, changed: true, revision: 'r3' } });
    await renderModelsRoute('/admin/models/only-one?tab=access', () => null, { Detail: DetailRoute });

    fireEvent.click(await screen.findByTestId('model-access-audience-btn'));
    const entitlements = screen.getByTestId('model-access-entitlements-input');
    fireEvent.keyDown(entitlements, { key: 'Backspace' });

    expect(await screen.findByTestId('model-access-admin-only')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('model-access-dialog-reason-input-preset-0'));
    expect(screen.getByTestId('model-access-dialog-confirm-btn')).toBeDisabled();
    fireEvent.click(screen.getByTestId('model-access-admin-only-checkbox'));
    fireEvent.click(screen.getByTestId('model-access-dialog-confirm-btn'));

    await waitFor(() =>
      expect(patch.mock.calls[0][1]).toMatchObject({ change: { allowedEntitlements: [] }, confirmAdminOnly: true })
    );
  });

  it('blocks a rank outside 0 to 100 and saves a valid one', async () => {
    serve([offRow]);
    patch.mockResolvedValue({ data: { entry: null, changed: true, revision: 'r3' } });
    await renderModelsRoute(`/admin/models/${BEDROCK_ID}?tab=access`, () => null, { Detail: DetailRoute });

    fireEvent.click(await screen.findByTestId('model-access-ranking-btn'));
    const rank = screen.getByTestId('model-access-rank-input');
    fireEvent.change(rank, { target: { value: '101' } });
    fireEvent.click(screen.getByTestId('model-access-dialog-reason-input-preset-0'));
    expect(screen.getByTestId('model-access-dialog-confirm-btn')).toBeDisabled();

    fireEvent.change(rank, { target: { value: '3' } });
    fireEvent.click(screen.getByTestId('model-access-dialog-confirm-btn'));
    await waitFor(() => expect(patch.mock.calls[0][1]).toMatchObject({ change: { rank: 3 } }));
  });

  it('offers only listed or limited models of the same type as a fallback, and still shows a saved one outside them', async () => {
    const main = modelRow({
      id: 'main-text',
      name: 'Main',
      access: {
        entry: {
          enabled: true,
          allowedUserTags: [],
          allowedEntitlements: ['base'],
          fallbackModel: 'old-text',
          updatedAt: '2026-11-01T00:00:00.000Z',
        },
        everyone: true,
        adminsOnly: false,
        freeTierLocked: false,
      },
    });
    serve([
      main,
      modelRow({ id: 'old-text', name: 'Old', status: 'hidden' }),
      modelRow({ id: 'good-text', name: 'Good', status: 'listed' }),
      modelRow({ id: 'beta-text', name: 'Beta', status: 'limited' }),
      modelRow({ id: 'review-text', name: 'Review', status: 'needs-review' }),
    ]);
    await renderModelsRoute('/admin/models/main-text?tab=access', () => null, { Detail: DetailRoute });

    fireEvent.click(await screen.findByTestId('model-access-ranking-btn'));
    await userEvent.click(screen.getByTestId('model-access-fallback-select'));

    await waitFor(() => expect(screen.getByRole('option', { name: 'Good (Listed)' })).toBeInTheDocument());
    const names = screen.getAllByRole('option').map(option => option.textContent);
    expect(names).toEqual(['Automatic', 'Old (Hidden)', 'Good (Listed)', 'Beta (Limited)']);
  });

  it('says in place when the fallback models fail to load, and asks again on Retry', async () => {
    serve([offRow]);
    const served = get.getMockImplementation()!;
    let failTypes = true;
    get.mockImplementation(async (url: string, config?: { params?: Record<string, string> }) => {
      if (url === '/api/admin/models' && config?.params?.types && failTypes) throw apiFailure(500, { error: 'down' });
      return served(url, config);
    });
    await renderModelsRoute(`/admin/models/${BEDROCK_ID}?tab=access`, () => null, { Detail: DetailRoute });

    fireEvent.click(await screen.findByTestId('model-access-ranking-btn'));
    expect(await screen.findByTestId('model-access-fallback-error')).toHaveTextContent(
      'Could not load the text models'
    );
    failTypes = false;
    fireEvent.click(screen.getByTestId('model-access-fallback-error-retry-btn'));

    await waitFor(() => expect(screen.queryByTestId('model-access-fallback-error')).not.toBeInTheDocument());
  });

  it('says in place when the user tags fail to load, and asks again on Retry', async () => {
    serve([offRow]);
    const served = get.getMockImplementation()!;
    let failTags = true;
    get.mockImplementation(async (url: string, config?: { params?: Record<string, string> }) => {
      if (url === '/api/admin/users/tags' && failTags) throw apiFailure(500, { error: 'down' });
      return served(url, config);
    });
    await renderModelsRoute(`/admin/models/${BEDROCK_ID}?tab=access`, () => null, { Detail: DetailRoute });

    fireEvent.click(await screen.findByTestId('model-access-audience-btn'));
    expect(await screen.findByTestId('model-access-tags-error')).toHaveTextContent('Could not load the existing tags');
    failTags = false;
    fireEvent.click(screen.getByTestId('model-access-tags-error-retry-btn'));

    await waitFor(() => expect(screen.queryByTestId('model-access-tags-error')).not.toBeInTheDocument());
  });

  it('shows why the admin log could not be loaded', async () => {
    serve([offRow]);
    const served = get.getMockImplementation()!;
    get.mockImplementation(async (url: string, config?: { params?: Record<string, string> }) => {
      if (url === '/api/admin/audit-log') throw apiFailure(503, { error: 'Audit log is unavailable' });
      return served(url, config);
    });
    await renderModelsRoute(`/admin/models/${BEDROCK_ID}?tab=admin`, () => null, { Detail: DetailRoute });

    expect(await screen.findByText(/The admin log could not be loaded\. Audit log is unavailable/)).toBeInTheDocument();
  });

  it('merges the access, price and lifecycle audit trails newest first', async () => {
    serve([offRow], {
      [`llmModelConfigurations:${BEDROCK_ID}`]: [auditEntry('a1', '2026-11-01T00:00:00.000Z', 'Turned off')],
      [`${BEDROCK_ID}:per_token`]: [auditEntry('p1', '2026-11-05T00:00:00.000Z', 'Repriced')],
    });
    await renderModelsRoute(`/admin/models/${BEDROCK_ID}?tab=admin`, () => null, { Detail: DetailRoute });

    await waitFor(() => expect(screen.getAllByTestId('model-admin-log-row')).toHaveLength(2));
    const rows = screen.getAllByTestId('model-admin-log-row');
    expect(rows[0]).toHaveTextContent('Repriced');
    expect(rows[1]).toHaveTextContent('Turned off');
  });
});
