/**
 * Unit tests for the shared semantic-search core. The SPA route's suite
 * (pages/api/data-lakes/__tests__/semantic-search.test.ts) covers billing, model binding and the
 * audit event through this module; these pin what only the public door relies on: the scope and
 * the `restrictToDataLake` opt-in reach the search call untouched, and each refusal is an outcome.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';

const { mockSemanticSearch, mockGetEffectiveLLMApiKeys } = vi.hoisted(() => ({
  mockSemanticSearch: vi.fn(),
  mockGetEffectiveLLMApiKeys: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  fabFileRepository: {},
  fabFileChunkRepository: {},
  apiKeyRepository: {},
  adminSettingsRepository: { getSettingsValue: async () => undefined },
  creditTransactionRepository: {},
  organizationRepository: { shareable: { findAccessibleById: async () => null } },
  usageEventRepository: {},
  userRepository: { findById: async () => null },
  lakeAccessEventRepository: {},
  scopedSettingsRepository: {},
}));
vi.mock('@bike4mind/services', () => ({
  apiKeyService: { getEffectiveLLMApiKeys: mockGetEffectiveLLMApiKeys },
  scopedSettingsService: { scopeForCaller: () => ({ userId: 'u1' }) },
  isOperationalBillingEnabled: async () => false,
  recordOperationalUsage: vi.fn(),
  creditService: { isMemberCreditCapExceeded: () => false },
  dataLakeService: {
    semanticDataLakeSearch: mockSemanticSearch,
    resolveSearchBudgets: async () => ({ maxFiles: 10, maxChunks: 100 }),
    lakeMembershipsFrom: () => [],
    warnIfManyLakeMemberships: () => undefined,
    attributeAccessedLakeIds: () => [],
    recordLakeAccessEvent: vi.fn(),
    openSearchChunkAdapter: undefined,
  },
}));
vi.mock('@bike4mind/utils', () => ({
  createTokenizer: () => ({ countTokens: async () => 3 }),
  getSettingsByNames: vi.fn(),
  normalizeId: (value: unknown) => (value == null ? undefined : String(value)),
}));
vi.mock('@bike4mind/db-core', () => ({ selfHostOpenSearchEnabled: () => false }));
vi.mock('@server/dataLakes/requestMembership', () => ({ getRequestMembershipOrgIds: async () => [] }));
vi.mock('@server/dataLakes/resolveAuditPrincipal', () => ({ resolveAuditPrincipal: () => ({}) }));

import { runLakeSemanticSearch, type LakeSemanticSearchInput } from './runLakeSemanticSearch';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const req = { user: { id: 'u1', groups: [] }, logger } as unknown as Request;

const SCOPE = {
  dataLakeTags: ['datalake:target'],
  dataLakeTagPrefixes: [],
  scopedTagPrefixes: ['target:'],
  lakes: [],
} as unknown as LakeSemanticSearchInput['scope'];

const input = (overrides: Partial<LakeSemanticSearchInput> = {}): LakeSemanticSearchInput => ({
  query: 'refund policy',
  topK: 5,
  minScore: 0,
  tags: [],
  embeddingModel: 'text-embedding-3-small',
  embeddingModelExplicit: false,
  scope: SCOPE,
  isAborted: () => false,
  surface: 'data-lake-semantic-search',
  ...overrides,
});

const SEARCH = { results: [], alternateModelsEmbedded: [] };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetEffectiveLLMApiKeys.mockResolvedValue({ openai: 'sk-test' });
  mockSemanticSearch.mockResolvedValue(SEARCH);
});

describe('runLakeSemanticSearch', () => {
  it('hands the scope to the search and sets restrictToDataLake only when asked', async () => {
    await expect(runLakeSemanticSearch(req, input({ restrictToDataLake: true }))).resolves.toEqual({
      kind: 'ok',
      search: SEARCH,
    });
    expect(mockSemanticSearch.mock.calls[0][0]).toMatchObject({
      dataLakeTags: ['datalake:target'],
      restrictToDataLake: true,
      topK: 5,
    });

    await runLakeSemanticSearch(req, input());
    expect(mockSemanticSearch.mock.calls[1][0]).not.toHaveProperty('restrictToDataLake');
  });

  it('returns empty without embedding when the scope holds no lake', async () => {
    const outcome = await runLakeSemanticSearch(req, input({ scope: { ...SCOPE, dataLakeTags: [] } }));
    expect(outcome).toMatchObject({ kind: 'empty', embeddingModel: 'text-embedding-3-small' });
    expect(mockSemanticSearch).not.toHaveBeenCalled();
  });

  it('returns provider_not_configured for a named model with no credential', async () => {
    mockGetEffectiveLLMApiKeys.mockResolvedValue({});
    const outcome = await runLakeSemanticSearch(req, input({ embeddingModelExplicit: true }));
    expect(outcome).toEqual({ kind: 'provider_not_configured', message: expect.stringContaining('not configured') });
    expect(mockSemanticSearch).not.toHaveBeenCalled();
  });

  it('stops before searching once the caller has gone', async () => {
    await expect(runLakeSemanticSearch(req, input({ isAborted: () => true }))).resolves.toEqual({ kind: 'aborted' });
    expect(mockSemanticSearch).not.toHaveBeenCalled();
  });
});
