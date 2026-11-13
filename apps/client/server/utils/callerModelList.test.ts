import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelBackend, type IUserDocument, type ModelInfo, type SupersededModelInfo } from '@bike4mind/common';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    getAvailableModels: vi.fn(),
    getSupersededModels: vi.fn(),
    getSettingsMap: vi.fn(),
    loadFreeTierAllowedModels: vi.fn(),
    getUserEntitlements: vi.fn(),
    findAdminSetting: vi.fn(),
    cacheFind: vi.fn(),
    cacheCreateOrUpdate: vi.fn(),
    findOrg: vi.fn(),
  },
}));

vi.mock('@bike4mind/llm-adapters', () => ({
  PICKER_LISTING_OPTIONS: {},
  buildApiKeyTable: () => ({}),
  getAvailableModels: (...a: unknown[]) => mocks.getAvailableModels(...a),
  getSupersededModels: (...a: unknown[]) => mocks.getSupersededModels(...a),
  resolveSuccessorChain: (id: string) => (id === 'retired-claude' ? 'claude' : id),
}));
vi.mock('@bike4mind/services', () => ({
  apiKeyService: { getEffectiveLLMApiKeys: vi.fn(async () => ({})) },
}));
// The real predicates, so the gate rule is exercised as production applies it; only the settings read is faked.
vi.mock('@bike4mind/services/llm/modelAdmission', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/services/llm/modelAdmission')>()),
  loadFreeTierAllowedModels: (...a: unknown[]) => mocks.loadFreeTierAllowedModels(...a),
}));
vi.mock('@bike4mind/server-utils/entitlements/index', () => ({
  getUserEntitlements: (...a: unknown[]) => mocks.getUserEntitlements(...a),
  toEntitlementUser: (user: unknown) => user,
}));
vi.mock('@bike4mind/database', () => ({
  apiKeyRepository: {},
  adminSettingsRepository: { findOne: (...a: unknown[]) => mocks.findAdminSetting(...a) },
  organizationRepository: { findById: (...a: unknown[]) => mocks.findOrg(...a) },
  cacheRepository: {
    find: (...a: unknown[]) => mocks.cacheFind(...a),
    createOrUpdate: (...a: unknown[]) => mocks.cacheCreateOrUpdate(...a),
  },
}));
// The real getSettingsValue, so the setting is parsed exactly as production parses it.
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap: (...a: unknown[]) => mocks.getSettingsMap(...a),
}));

import { Logger } from '@bike4mind/observability';
import { getCallerModelList, resolveCallerDefaultModel } from './callerModelList';

const textModel = (id: string, overrides: Partial<ModelInfo> = {}): ModelInfo =>
  ({
    id,
    type: 'text',
    name: id,
    backend: ModelBackend.OpenAI,
    contextWindow: 128_000,
    max_tokens: 16_000,
    supportsImageVariation: false,
    pricing: { 128_000: { input: 2e-6, output: 8e-6 } },
    ...overrides,
  }) as ModelInfo;

const priced = textModel('priced');
const unpriced = textModel('unpriced', { pricing: {} });
const free = textModel('free', { freeToRun: true, pricing: { 128_000: { input: 0, output: 0 } } });

const makeUser = (overrides: Partial<IUserDocument> = {}): IUserDocument =>
  ({ id: 'user-1', isAdmin: false, tags: [], ...overrides }) as unknown as IUserDocument;

const callerList = (user: IUserDocument | null) => getCallerModelList(user, { log: vi.fn() });
const listedIds = async (user: IUserDocument | null = makeUser()) =>
  (await callerList(user)).models.map(model => model.id);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAvailableModels.mockResolvedValue([priced, unpriced, free]);
  mocks.getSupersededModels.mockReturnValue([]);
  mocks.getSettingsMap.mockResolvedValue({ enforceCredits: 'false' });
  mocks.loadFreeTierAllowedModels.mockResolvedValue(undefined);
  mocks.getUserEntitlements.mockResolvedValue(['base']);
  mocks.findAdminSetting.mockResolvedValue(null);
  mocks.cacheFind.mockResolvedValue([]);
  mocks.cacheCreateOrUpdate.mockResolvedValue(undefined);
  mocks.findOrg.mockResolvedValue(null);
});

describe('getCallerModelList unpriced text models', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('drops an unpriced text model when credits are enforced', async () => {
    mocks.getSettingsMap.mockResolvedValue({ enforceCredits: 'true' });

    expect(await listedIds()).toEqual(['priced', 'free']);
    // The upgrade offers are resolved against the same filtered list.
    expect(mocks.getSupersededModels).toHaveBeenCalledWith([priced, free]);
  });

  it('lists it when credits are off', async () => {
    vi.stubEnv('B4M_SELF_HOST', 'true');
    mocks.getSettingsMap.mockResolvedValue({ enforceCredits: 'false' });

    expect(await listedIds()).toEqual(['priced', 'unpriced', 'free']);
  });
});

describe('getCallerModelList model-list revision', () => {
  const ENTRY_KEY = 'model-list:user-1:credits-on';
  const revisionRow = (revision: string) => ({ key: 'model-list-revision', result: { revision } });
  const entry = (models: ModelInfo[], modelListRevision?: string | null) => ({
    key: ENTRY_KEY,
    result: { models, supersededModels: [], ...(modelListRevision === undefined ? {} : { modelListRevision }) },
  });
  const cachedOnly = textModel('cached-only');

  it('reads the entry and the revision in one query', async () => {
    await callerList(makeUser());

    expect(mocks.cacheFind).toHaveBeenCalledTimes(1);
    expect(mocks.cacheFind).toHaveBeenCalledWith({ key: { $in: [ENTRY_KEY, 'model-list-revision'] } });
  });

  it('serves an entry stamped with the current revision', async () => {
    mocks.cacheFind.mockResolvedValue([entry([cachedOnly], 'rev-1'), revisionRow('rev-1')]);

    const list = await callerList(makeUser());

    expect(list.models.map(model => model.id)).toEqual(['cached-only']);
    expect(list.modelListRevision).toBe('rev-1');
    expect(mocks.getAvailableModels).not.toHaveBeenCalled();
  });

  it('rebuilds past an entry stamped with an older revision, forcing the process cache to rebuild too', async () => {
    mocks.cacheFind.mockResolvedValue([entry([cachedOnly], 'rev-1'), revisionRow('rev-2')]);

    const list = await callerList(makeUser());

    expect(list.models.map(model => model.id)).toEqual(['priced', 'free']);
    expect(list.modelListRevision).toBe('rev-2');
    expect(mocks.getAvailableModels).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ catalogRevision: 'rev-2' })
    );
    expect(mocks.cacheCreateOrUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ key: ENTRY_KEY, result: expect.objectContaining({ modelListRevision: 'rev-2' }) })
    );
  });

  it('rebuilds past an entry written before any revision once one exists', async () => {
    mocks.cacheFind.mockResolvedValue([entry([cachedOnly]), revisionRow('rev-1')]);

    await callerList(makeUser());

    expect(mocks.getAvailableModels).toHaveBeenCalledTimes(1);
  });

  it('serves an entry written before any revision while none exists', async () => {
    mocks.cacheFind.mockResolvedValue([entry([cachedOnly])]);

    const list = await callerList(makeUser());

    expect(list.models.map(model => model.id)).toEqual(['cached-only']);
    expect(list.modelListRevision).toBeNull();
    expect(mocks.getAvailableModels).not.toHaveBeenCalled();
  });

  it('passes no revision down while none exists', async () => {
    await callerList(makeUser());

    expect(mocks.getAvailableModels).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.objectContaining({ catalogRevision: expect.anything() })
    );
  });

  describe('when the catalog could not be read', () => {
    beforeEach(() => {
      mocks.getAvailableModels.mockImplementation(
        async (_keys: unknown, options: { onCatalogUnavailable?: () => void }) => {
          options.onCatalogUnavailable?.();
          return [priced, free];
        }
      );
      mocks.cacheFind.mockResolvedValue([revisionRow('rev-2')]);
    });

    it('does not pass the fallback off as the current revision', async () => {
      const list = await callerList(makeUser());

      expect(list.models.map(model => model.id)).toEqual(['priced', 'free']);
      expect(list.modelListRevision).toBeNull();
      expect(list.catalogUnavailable).toBe(true);
    });

    it('does not cache the fallback for other requests', async () => {
      await callerList(makeUser());

      expect(mocks.cacheCreateOrUpdate).not.toHaveBeenCalled();
    });
  });

  it('marks a list built from the catalog as such, and caches it', async () => {
    mocks.cacheFind.mockResolvedValue([revisionRow('rev-2')]);

    const list = await callerList(makeUser());

    expect(list.catalogUnavailable).toBe(false);
    expect(list.modelListRevision).toBe('rev-2');
    expect(mocks.cacheCreateOrUpdate).toHaveBeenCalledTimes(1);
  });
});

describe('getCallerModelList free-tier gate', () => {
  const image = textModel('image-model', { type: 'image' });
  const allowed = new Set(['priced']);
  // What the caller sees with the gate removing nothing: hosted credit enforcement still drops
  // 'unpriced' on its own, so it is absent here regardless of the gate.
  const ungated = ['priced', 'free', 'image-model'];

  beforeEach(() => {
    mocks.getAvailableModels.mockResolvedValue([priced, unpriced, free, image]);
    mocks.loadFreeTierAllowedModels.mockResolvedValue(allowed);
  });

  it('keeps only allowlisted models of any modality for a free user', async () => {
    expect(await listedIds()).toEqual(['priced']);
  });

  it('lists every text model but locks unlisted media while text models are open', async () => {
    mocks.loadFreeTierAllowedModels.mockResolvedValue(Object.assign(new Set(['priced']), { textModelsOpen: true }));
    const list = await callerList(makeUser());

    expect(list.models.map(model => model.id)).toEqual(['priced', 'free']);
    expect(list.lockedModels.map(model => model.id)).toEqual(['image-model']);
  });

  it('lists explicitly allowlisted media for a free user', async () => {
    mocks.loadFreeTierAllowedModels.mockResolvedValue(new Set(['priced', 'image-model']));

    expect(await listedIds()).toEqual(['priced', 'image-model']);
  });

  it('moves paid-only models of any modality to lockedModels, marked locked, for a free user', async () => {
    const list = await callerList(makeUser());

    expect(list.lockedModels.map(model => model.id)).toEqual(['free', 'image-model']);
    expect(list.lockedModels.every(model => model.access?.locked === true)).toBe(true);
    expect(list.lockedModels[0].access?.reason).toBe('requires_paid_plan');
    expect(list.models.some(model => model.access)).toBe(false);
  });

  it('splits a cached list without lockedModels for a free user, without recomputing', async () => {
    mocks.cacheFind.mockResolvedValue([
      { key: 'model-list:user-1:credits-on', result: { models: [priced, free, image], supersededModels: [] } },
    ]);
    mocks.getAvailableModels.mockClear();

    const list = await callerList(makeUser());

    expect(list.models.map(model => model.id)).toEqual(['priced']);
    expect(list.lockedModels.map(model => model.id)).toEqual(['free', 'image-model']);
    expect(list.lockedModels.every(model => model.access?.locked === true)).toBe(true);
    expect(mocks.getAvailableModels).not.toHaveBeenCalled();
  });

  it('leaves disabled and retired models out of lockedModels, since no upgrade unlocks them', async () => {
    const disabled = textModel('disabled-model', { disabled: true });
    const retired = textModel('retired-model', { deprecationDate: '2000-01-01' });
    mocks.getAvailableModels.mockResolvedValue([priced, free, disabled, retired]);

    const list = await callerList(makeUser());

    expect(list.models.map(model => model.id)).toEqual(['priced']);
    expect(list.lockedModels.map(model => model.id)).toEqual(['free']);
  });

  it.each([
    ['a plan:paid user', makeUser(), () => mocks.getUserEntitlements.mockResolvedValue(['base', 'plan:paid'])],
    ['an admin', makeUser({ isAdmin: true }), () => undefined],
    ['an anonymous caller', null, () => undefined],
    ['any caller when the gate is off', makeUser(), () => mocks.loadFreeTierAllowedModels.mockResolvedValue(undefined)],
  ])('locks nothing for %s', async (_label, user, arrange) => {
    arrange();

    expect((await callerList(user)).lockedModels).toEqual([]);
  });

  it('never points an upgrade offer at a locked model', async () => {
    mocks.getSupersededModels.mockReturnValue([{ id: 'old', replacementId: 'free' } as unknown as SupersededModelInfo]);

    const list = await callerList(makeUser());

    expect(list.lockedModels.map(model => model.id)).toContain('free');
    expect(list.supersededModels).toEqual([]);
  });

  it('lists everything for a user holding plan:paid', async () => {
    mocks.getUserEntitlements.mockResolvedValue(['base', 'plan:paid']);

    expect(await listedIds()).toEqual(ungated);
  });

  it.each([
    ['an admin', { isAdmin: true }],
    ['a developer-tagged user', { tags: ['Developer'] }],
  ])('lists everything for %s', async (_label, overrides) => {
    expect(await listedIds(makeUser(overrides))).toEqual(ungated);
  });

  it('lists everything when the gate is off', async () => {
    mocks.loadFreeTierAllowedModels.mockResolvedValue(undefined);

    expect(await listedIds()).toEqual(ungated);
  });

  it('never filters an anonymous caller', async () => {
    expect(await listedIds(null)).toEqual(ungated);
    expect(mocks.loadFreeTierAllowedModels).not.toHaveBeenCalled();
  });

  it('drops upgrade offers whose replacement was filtered out', async () => {
    const toPaid = { id: 'old-a', replacementId: 'free' } as unknown as SupersededModelInfo;
    const toAllowed = { id: 'old-b', replacementId: 'priced' } as unknown as SupersededModelInfo;
    mocks.getSupersededModels.mockReturnValue([toPaid, toAllowed]);

    expect((await callerList(makeUser())).supersededModels).toEqual([toAllowed]);
  });

  it('fails closed to the free-tier models, and warns, when the entitlement read rejects', async () => {
    const warn = vi.spyOn(Logger.globalInstance, 'warn').mockImplementation(() => undefined);
    mocks.getUserEntitlements.mockRejectedValue(new Error('subscription db down'));

    expect(await listedIds()).toEqual(['priced']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('entitlement read failed'), expect.anything());
    warn.mockRestore();
  });

  it('lists unfiltered, and warns, when the allowlist read rejects', async () => {
    const warn = vi.spyOn(Logger.globalInstance, 'warn').mockImplementation(() => undefined);
    mocks.loadFreeTierAllowedModels.mockRejectedValue(new Error('settings db down'));

    expect(await listedIds()).toEqual(ungated);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('allowlist read failed'), expect.anything());
    warn.mockRestore();
  });
});

describe('resolveCallerDefaultModel', () => {
  const premium = textModel('premium');
  const cheap = textModel('cheap');
  const cheaper = textModel('cheaper');
  const resolveDefault = (user: IUserDocument = makeUser()) =>
    resolveCallerDefaultModel('premium', user, { log: vi.fn() });

  beforeEach(() => {
    mocks.getAvailableModels.mockResolvedValue([premium, cheap, cheaper]);
    // 'missing' is allowlisted but not listed for this caller, so it is skipped.
    mocks.loadFreeTierAllowedModels.mockResolvedValue(new Set(['missing', 'cheaper', 'cheap']));
  });

  it('starts a free user on the first listed allowlisted model, in admin order', async () => {
    expect(await resolveDefault()).toBe('cheaper');
  });

  it('skips a disabled allowlisted model', async () => {
    mocks.getAvailableModels.mockResolvedValue([premium, cheap, textModel('cheaper', { disabled: true })]);

    expect(await resolveDefault()).toBe('cheap');
  });

  it('keeps an unlisted text default while text models are open', async () => {
    mocks.loadFreeTierAllowedModels.mockResolvedValue(Object.assign(new Set(['cheap']), { textModelsOpen: true }));

    expect(await resolveDefault()).toBe('premium');
  });

  it('falls back from a media default while text models are open', async () => {
    mocks.getAvailableModels.mockResolvedValue([textModel('premium', { type: 'image' }), cheap, cheaper]);
    mocks.loadFreeTierAllowedModels.mockResolvedValue(Object.assign(new Set(['cheap']), { textModelsOpen: true }));

    expect(await resolveDefault()).toBe('cheap');
  });

  it('falls back from a default missing from the catalog while text models are open', async () => {
    mocks.getAvailableModels.mockResolvedValue([cheap, cheaper]);
    mocks.loadFreeTierAllowedModels.mockResolvedValue(Object.assign(new Set(['cheap']), { textModelsOpen: true }));

    expect(await resolveDefault()).toBe('cheap');
  });

  it('keeps the default when it is allowlisted', async () => {
    mocks.loadFreeTierAllowedModels.mockResolvedValue(new Set(['cheap', 'premium']));

    expect(await resolveDefault()).toBe('premium');
  });

  it('keeps the default for a user holding plan:paid', async () => {
    mocks.getUserEntitlements.mockResolvedValue(['base', 'plan:paid']);

    expect(await resolveDefault()).toBe('premium');
  });

  it('keeps the default for an admin without reading the allowlist', async () => {
    expect(await resolveDefault(makeUser({ isAdmin: true }))).toBe('premium');
    expect(mocks.loadFreeTierAllowedModels).not.toHaveBeenCalled();
  });

  it('keeps the default when the gate is off', async () => {
    mocks.loadFreeTierAllowedModels.mockResolvedValue(undefined);

    expect(await resolveDefault()).toBe('premium');
  });

  it('keeps the default when no allowlisted model is listed, so admission refuses it', async () => {
    mocks.getAvailableModels.mockResolvedValue([premium]);

    expect(await resolveDefault()).toBe('premium');
  });

  it('skips an allowlisted model the admin model config restricts to a tag the user lacks', async () => {
    mocks.findAdminSetting.mockResolvedValue({
      settingValue: [{ id: 'cheaper', enabled: true, allowedUserTags: ['beta'], allowedEntitlements: [] }],
    });

    expect(await resolveDefault()).toBe('cheap');
  });

  it('propagates an entitlement read failure instead of treating a paid user as free', async () => {
    mocks.getUserEntitlements.mockRejectedValue(new Error('entitlements down'));

    await expect(resolveDefault()).rejects.toThrow('entitlements down');
  });

  it('propagates an allowlist read failure instead of opening the gate', async () => {
    mocks.loadFreeTierAllowedModels.mockRejectedValue(new Error('settings db down'));

    await expect(resolveDefault()).rejects.toThrow('settings db down');
  });
});

describe('org model policy', () => {
  const claude = textModel('claude', { backend: ModelBackend.Anthropic });
  const policy = (overrides: Record<string, unknown>) => ({
    modelPolicy: { allowedProviders: null, allowedModels: null, allowedTools: null, ...overrides },
  });
  const orgList = (user: IUserDocument = makeUser()) =>
    getCallerModelList(user, { log: vi.fn() }, { organizationId: 'org-1' });

  beforeEach(() => {
    mocks.getAvailableModels.mockResolvedValue([priced, free, claude]);
  });

  it('moves models off an allowed provider to lockedModels as org_policy', async () => {
    mocks.findOrg.mockResolvedValue(policy({ allowedProviders: [ModelBackend.Anthropic] }));
    const list = await orgList();

    expect(mocks.findOrg).toHaveBeenCalledWith('org-1');
    expect(list.models.map(model => model.id)).toEqual(['claude']);
    expect(list.lockedModels.map(model => [model.id, model.access?.reason])).toEqual([
      ['priced', 'org_policy'],
      ['free', 'org_policy'],
    ]);
  });

  it('applies the model allowlist', async () => {
    mocks.findOrg.mockResolvedValue(policy({ allowedModels: ['free'] }));

    expect((await orgList()).models.map(model => model.id)).toEqual(['free']);
  });

  it('locks every model when the stored policy is invalid', async () => {
    mocks.findOrg.mockResolvedValue({ modelPolicy: { allowedProviders: 'not-a-list' } });
    const list = await orgList();

    expect(list.models).toEqual([]);
    expect(list.lockedModels).toHaveLength(3);
  });

  it('lists everything for an org without a policy, and reads no org without an id', async () => {
    mocks.findOrg.mockResolvedValue({});
    expect((await orgList()).models).toHaveLength(3);

    mocks.findOrg.mockClear();
    expect((await callerList(makeUser())).models).toHaveLength(3);
    expect(mocks.findOrg).not.toHaveBeenCalled();
  });

  it('relabels a paid-plan lock the org also disallows, since no upgrade unlocks it', async () => {
    mocks.loadFreeTierAllowedModels.mockResolvedValue(new Set(['priced']));
    mocks.findOrg.mockResolvedValue(policy({ allowedModels: ['priced', 'claude'] }));
    const list = await orgList();

    expect(list.models.map(model => model.id)).toEqual(['priced']);
    expect(list.lockedModels.map(model => [model.id, model.access?.reason])).toEqual([
      ['free', 'org_policy'],
      ['claude', 'requires_paid_plan'],
    ]);
  });

  it('starts the default on the first allowed text model when the org disallows it', async () => {
    mocks.findOrg.mockResolvedValue(policy({ allowedModels: ['claude'] }));

    expect(await resolveCallerDefaultModel('priced', makeUser(), { log: vi.fn() }, { organizationId: 'org-1' })).toBe(
      'claude'
    );
    expect(await resolveCallerDefaultModel('priced', makeUser(), { log: vi.fn() })).toBe('priced');
  });

  it('reads the org once per default resolution', async () => {
    mocks.findOrg.mockResolvedValue(policy({ allowedModels: ['claude'] }));
    mocks.findOrg.mockClear();
    await resolveCallerDefaultModel('priced', makeUser(), { log: vi.fn() }, { organizationId: 'org-1' });
    expect(mocks.findOrg).toHaveBeenCalledTimes(1);
  });

  it('keeps offering the successor of an allowlisted retired model', async () => {
    mocks.findOrg.mockResolvedValue(policy({ allowedModels: ['retired-claude'] }));
    expect(await resolveCallerDefaultModel('priced', makeUser(), { log: vi.fn() }, { organizationId: 'org-1' })).toBe(
      'claude'
    );
  });
});
