import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { modelDiscoveryService } from '@bike4mind/services';

const h = vi.hoisted(() => ({
  catalogRows: vi.fn(async (): Promise<unknown[]> => []),
  pendingSuggestions: vi.fn(async (): Promise<unknown[]> => []),
}));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { findOne: async () => null, getSettingsValue: async () => undefined },
  apiKeyRepository: {},
  modelCatalogRepository: { rowsInForce: () => h.catalogRows(), discoveryMilestones: async () => new Map() },
  modelDiscoveryStateRepository: { pendingSuggestions: () => h.pendingSuggestions() },
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
const NEEDS_REVIEW_DATED = 'gpt-filter-deprecating';
const HIDDEN_DATED = 'anthropic.claude-retiring-v1:0';
const HIDDEN_FAR = 'anthropic.claude-later-v1:0';
const NOT_ENTITLED = { disabled: true, disabledReason: 'not entitled in this AWS account' };

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
    // 2026-08-21 is 20 days out, 2026-10-31 is 91.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-01T12:00:00Z'));
    h.pendingSuggestions.mockResolvedValue([
      {
        modelId: NEEDS_REVIEW_DATED,
        suggestion: { replacedBy: 'gpt-filter-next', source: 'openai', suggestedAt: new Date('2026-07-30T00:00:00Z') },
      },
    ]);
    h.catalogRows.mockResolvedValue([
      row(NEEDS_REVIEW_DATED, {
        vendor: 'openai',
        backend: 'openai',
        adapterFamily: 'openai-chat',
        dispatchProfile: { maxTokensParam: 'max_completion_tokens', toolTransport: 'chat' },
        lifecycle: { status: 'active', deprecationDate: '2026-08-21' },
      }),
      row(HIDDEN_DATED, { ...NOT_ENTITLED, lifecycle: { status: 'active', retirementDate: '2026-09-01' } }),
      row(HIDDEN_FAR, { ...NOT_ENTITLED, lifecycle: { status: 'active', retirementDate: '2026-10-31' } }),
      row(FOUNDATION_ID, {
        disabled: true,
        disabledReason: 'not invocable on demand; use its region-prefixed inference profile id',
      }),
      row('anthropic.claude-entitled-v1:0', { disabled: true, disabledReason: 'not entitled in this AWS account' }),
      row('Anthropic.Claude_Mixed-v1:0', { disabled: true, disabledReason: 'not entitled in this AWS account' }),
      row('anthropic.claude_under-v1:0', { disabled: true, disabledReason: 'not entitled in this AWS account' }),
    ]);
  });

  it('selects exactly the ids the list shows for the same filter, across every page', async () => {
    const filters = [
      {},
      { view: 'hidden' as const },
      { view: 'needs-review' as const },
      { view: 'retiring' as const },
      { providers: ['bedrock'], view: 'hidden' as const },
    ];
    for (const filter of filters) {
      const page = modelDiscoveryService.adminModelListPage(await loadAdminModelRows(), { filter, pageSize: 500 });
      expect(page.total).toBeLessThan(500);
      expect(await resolveAdminModelFilterIds(filter)).toEqual(
        page.models.map(model => model.id).sort(modelDiscoveryService.compareAdminModelIds)
      );
    }
    expect(await resolveAdminModelFilterIds({ view: 'hidden', providers: ['bedrock'] })).toEqual(
      expect.arrayContaining(['Anthropic.Claude_Mixed-v1:0', 'anthropic.claude_under-v1:0'])
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('selects the Retiring view by lifecycle dates, whatever reason outranks Retiring in the status', async () => {
    const rows = await loadAdminModelRows();
    const status = new Map(rows.map(model => [model.id, model.status]));
    expect(status.get(NEEDS_REVIEW_DATED)).toBe('needs-review');
    expect(status.get(HIDDEN_DATED)).toBe('hidden');

    const retiring = await resolveAdminModelFilterIds({ view: 'retiring' });
    expect(retiring).toEqual(expect.arrayContaining([NEEDS_REVIEW_DATED, HIDDEN_DATED]));
    expect(retiring).not.toContain(HIDDEN_FAR);
    expect(
      modelDiscoveryService.adminModelListPage(rows, { filter: { view: 'retiring' }, pageSize: 500 }).viewCounts
        .retiring
    ).toBe(retiring.length);
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
