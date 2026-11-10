import { describe, it, expect, vi, beforeEach } from 'vitest';
import { modelDiscoveryService } from '@bike4mind/services';

const h = vi.hoisted(() => ({ catalogRows: vi.fn(async (): Promise<unknown[]> => []) }));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { findOne: async () => null },
  apiKeyRepository: {},
  modelCatalogRepository: { rowsInForce: () => h.catalogRows(), discoveryMilestones: async () => new Map() },
  modelDiscoveryStateRepository: { pendingSuggestions: async () => [] },
  modelPriceRepository: { rowsInForce: async () => [] },
}));
vi.mock('@bike4mind/services', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/services')>()),
  apiKeyService: { getEffectiveLLMApiKeys: async () => ({ openai: 'k', anthropic: 'k', gemini: 'k', xai: 'k' }) },
}));
vi.mock('@bike4mind/services/llm/modelAdmission', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/services/llm/modelAdmission')>()),
  loadFreeTierAllowedModels: async () => undefined,
}));
vi.mock('@server/billing/meterPlatformCompletion', () => ({ isCreditsEnforced: async () => false }));

import { resolveAdminModelFilterIds } from './adminModelFilter';
import { loadAdminModelRows } from './adminModelList';

const FOUNDATION_ID = 'anthropic.claude-filter-v1:0';

const row = (modelId: string, patch: Record<string, unknown>) => ({
  modelId,
  schemaVersion: 2,
  source: 'discovery',
  ownedGroups: ['identity', 'limits', 'lifecycle', 'availability', 'dispatch'],
  patch: {
    id: modelId,
    vendor: 'anthropic',
    backend: 'bedrock',
    type: 'text',
    name: modelId,
    contextWindow: 200_000,
    lifecycle: { status: 'active' },
    ...patch,
  },
  effectiveFrom: new Date('2026-07-01T00:00:00Z'),
});

describe('resolveAdminModelFilterIds', () => {
  beforeEach(() => {
    h.catalogRows.mockResolvedValue([
      row(FOUNDATION_ID, {
        disabled: true,
        disabledReason: 'not invocable on demand; use its region-prefixed inference profile id',
      }),
      row('anthropic.claude-entitled-v1:0', { disabled: true, disabledReason: 'not entitled in this AWS account' }),
    ]);
  });

  it('selects exactly the ids the list shows for the same filter, across every page', async () => {
    for (const filter of [{}, { view: 'hidden' as const }, { providers: ['bedrock'], view: 'hidden' as const }]) {
      const page = modelDiscoveryService.adminModelListPage(await loadAdminModelRows(), { filter, pageSize: 500 });
      expect(page.total).toBeLessThan(500);
      expect(await resolveAdminModelFilterIds(filter)).toEqual(page.models.map(model => model.id).sort());
    }
  });

  it('leaves out profile-only foundation ids unless the filter restores them', async () => {
    const hidden = await resolveAdminModelFilterIds({ view: 'hidden', providers: ['bedrock'] });
    expect(hidden).toContain('anthropic.claude-entitled-v1:0');
    expect(hidden).not.toContain(FOUNDATION_ID);

    expect(
      await resolveAdminModelFilterIds({ view: 'hidden', providers: ['bedrock'], showFoundationIds: true })
    ).toContain(FOUNDATION_ID);
  });

  it('answers 400 to a filter it cannot read', async () => {
    await expect(resolveAdminModelFilterIds({ view: 'nope' } as never)).rejects.toMatchObject({ statusCode: 400 });
    await expect(resolveAdminModelFilterIds({ ids: ['x'] } as never)).rejects.toMatchObject({ statusCode: 400 });
  });
});
