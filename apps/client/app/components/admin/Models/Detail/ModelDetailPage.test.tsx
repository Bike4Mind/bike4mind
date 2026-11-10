import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { apiFailure, listResponse, modelRow, renderModelsRoute } from '../modelsTestUtils';
import { isModelDetailTab, type ModelDetailTab } from '../modelDetailSearch';
import { useModelsNavigation } from '../modelsNavigation';

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

const serve = (rows: ReturnType<typeof modelRow>[], audit: Record<string, unknown[]> = {}) =>
  get.mockImplementation(async (url: string, config?: { params?: Record<string, string> }) => {
    if (url === '/api/admin/models') {
      const search = config?.params?.search ?? '';
      return { data: listResponse(rows.filter(row => row.id.startsWith(search))) };
    }
    if (url === '/api/admin/audit-log') {
      return { data: { entries: audit[config?.params?.targetId ?? ''] ?? [], nextCursor: null } };
    }
    if (url === '/api/admin/users/tags') return { data: { tags: [{ tag: 'beta', count: 4 }] } };
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

    expect(await screen.findByTestId('model-detail-not-found')).toHaveTextContent('No model with id missing-model');
  });

  it('shows the status, the reason with its fix action and the access summary', async () => {
    serve([offRow]);
    await renderModelsRoute(`/admin/models/${BEDROCK_ID}`, () => null, { Detail: DetailRoute });

    expect(await screen.findByTestId('model-detail-status')).toHaveTextContent('Hidden');
    expect(screen.getByTestId('model-detail-reason')).toHaveTextContent('Turned off by an admin');
    expect(screen.getByTestId('model-detail-fix-btn')).toHaveTextContent('Turn on');
    expect(screen.getByTestId('model-detail-toggle-btn')).toHaveTextContent('Turn on');
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
