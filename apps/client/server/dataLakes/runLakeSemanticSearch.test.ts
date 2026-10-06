/**
 * Unit tests for the shared semantic-search core. The SPA route's suite
 * (pages/api/data-lakes/__tests__/semantic-search.test.ts) covers billing, model binding and the
 * audit event through this module; these pin what only the public door relies on: the scope and
 * the `restrictToDataLake` opt-in reach the search call untouched, and each refusal is an outcome.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import { CreditHolderType } from '@bike4mind/common';

const {
  mockSemanticSearch,
  mockGetEffectiveLLMApiKeys,
  mockUserFindById,
  mockOrgFindById,
  mockFindAccessibleById,
  mockBillingEnabled,
  mockRecordOperationalUsage,
  mockIsCurrentOrgMember,
} = vi.hoisted(() => ({
  mockSemanticSearch: vi.fn(),
  mockGetEffectiveLLMApiKeys: vi.fn(),
  mockUserFindById: vi.fn(),
  mockOrgFindById: vi.fn(),
  mockFindAccessibleById: vi.fn(),
  mockBillingEnabled: vi.fn(),
  mockRecordOperationalUsage: vi.fn(),
  mockIsCurrentOrgMember: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  fabFileRepository: {},
  fabFileChunkRepository: {},
  apiKeyRepository: {},
  adminSettingsRepository: { getSettingsValue: async () => undefined },
  creditTransactionRepository: {},
  organizationRepository: { findById: mockOrgFindById, shareable: { findAccessibleById: mockFindAccessibleById } },
  usageEventRepository: {},
  userRepository: { findById: mockUserFindById },
  lakeAccessEventRepository: {},
  scopedSettingsRepository: {},
}));
vi.mock('@bike4mind/services', () => ({
  apiKeyService: { getEffectiveLLMApiKeys: mockGetEffectiveLLMApiKeys },
  scopedSettingsService: { scopeForCaller: () => ({ userId: 'u1' }) },
  isOperationalBillingEnabled: mockBillingEnabled,
  recordOperationalUsage: mockRecordOperationalUsage,
  organizationService: { isCurrentOrgMember: mockIsCurrentOrgMember },
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

import {
  runLakeSemanticSearch,
  resetSharedTokenizerForTests,
  type LakeSemanticSearchInput,
} from './runLakeSemanticSearch';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const req = { user: { id: 'u1', groups: [] }, headers: {}, logger } as unknown as Request;

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
  resetSharedTokenizerForTests();
  mockGetEffectiveLLMApiKeys.mockResolvedValue({ openai: 'sk-test' });
  mockSemanticSearch.mockResolvedValue(SEARCH);
  mockUserFindById.mockResolvedValue(null);
  mockOrgFindById.mockResolvedValue(null);
  mockFindAccessibleById.mockResolvedValue(null);
  mockBillingEnabled.mockResolvedValue(false);
  mockIsCurrentOrgMember.mockReturnValue(true);
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

describe('runLakeSemanticSearch billing owner and source', () => {
  const SEAT_ORG = { id: 'seat-org', currentCredits: 1000 };
  const KEY_ORG = { id: 'key-org', currentCredits: 1000 };
  const USER = { id: 'u1', organizationId: 'seat-org', currentCredits: 1000, isAdmin: false };

  const apiKeyReq = (apiKeyInfo: Record<string, unknown>, headers: Record<string, string> = {}) =>
    ({ user: { id: 'u1', groups: [], organizationId: 'seat-org' }, apiKeyInfo, headers, logger }) as unknown as Request;
  const jwtReq = {
    user: { id: 'u1', groups: [], organizationId: 'seat-org' },
    headers: {},
    logger,
  } as unknown as Request;
  const recorded = () => mockRecordOperationalUsage.mock.calls[0][0];

  beforeEach(() => {
    mockUserFindById.mockResolvedValue(USER);
    mockOrgFindById.mockResolvedValue(KEY_ORG);
    mockFindAccessibleById.mockResolvedValue(SEAT_ORG);
  });

  it("bills an org-billed key's organization, not the caller's seat, and stamps cli for the CLI", async () => {
    await runLakeSemanticSearch(
      apiKeyReq(
        { billingOwnerType: CreditHolderType.Organization, organizationId: 'key-org' },
        { 'user-agent': 'b4m-cli/0.9.3' }
      ),
      input()
    );

    expect(mockOrgFindById).toHaveBeenCalledWith('key-org');
    expect(mockFindAccessibleById).not.toHaveBeenCalled();
    expect(recorded()).toMatchObject({ organization: KEY_ORG, source: 'cli' });
  });

  it('bills the user for a user-billed key even when they hold an org seat', async () => {
    await runLakeSemanticSearch(
      apiKeyReq({ billingOwnerType: CreditHolderType.User, organizationId: 'seat-org' }),
      input()
    );

    expect(mockFindAccessibleById).not.toHaveBeenCalled();
    expect(recorded()).toMatchObject({ organization: null, source: 'api' });
  });

  it('bills the user for an org-billed key that carries no organization id', async () => {
    await runLakeSemanticSearch(apiKeyReq({ billingOwnerType: CreditHolderType.Organization }), input());

    expect(mockOrgFindById).not.toHaveBeenCalled();
    expect(recorded()).toMatchObject({ organization: null });
  });

  it("bills a browser/JWT caller's org seat", async () => {
    await runLakeSemanticSearch(jwtReq, input());

    expect(mockFindAccessibleById).toHaveBeenCalledWith(jwtReq.user, 'seat-org');
    expect(recorded()).toMatchObject({ organization: SEAT_ORG, source: 'api' });
  });

  it('refuses an org-billed key whose holder has left the org when billing is on', async () => {
    mockBillingEnabled.mockResolvedValue(true);
    mockIsCurrentOrgMember.mockReturnValue(false);

    await expect(
      runLakeSemanticSearch(
        apiKeyReq({ billingOwnerType: CreditHolderType.Organization, organizationId: 'key-org' }),
        input()
      )
    ).rejects.toThrow(/no longer a member/);
    expect(mockSemanticSearch).not.toHaveBeenCalled();
  });

  it('admits a platform admin holding an org-billed key for an org they are not on', async () => {
    mockBillingEnabled.mockResolvedValue(true);
    mockIsCurrentOrgMember.mockReturnValue(false);
    mockUserFindById.mockResolvedValue({ ...USER, isAdmin: true });

    await runLakeSemanticSearch(
      apiKeyReq({ billingOwnerType: CreditHolderType.Organization, organizationId: 'key-org' }),
      input()
    );

    expect(mockSemanticSearch).toHaveBeenCalled();
  });

  it('refuses an org-billed key whose organization no longer exists when billing is on', async () => {
    mockBillingEnabled.mockResolvedValue(true);
    mockOrgFindById.mockResolvedValue(null);

    await expect(
      runLakeSemanticSearch(
        apiKeyReq({ billingOwnerType: CreditHolderType.Organization, organizationId: 'key-org' }),
        input()
      )
    ).rejects.toThrow(/Billing organization not found/);
  });
});
