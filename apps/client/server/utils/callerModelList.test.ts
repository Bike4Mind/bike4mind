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
  },
}));

vi.mock('@bike4mind/llm-adapters', () => ({
  PICKER_LISTING_OPTIONS: {},
  buildApiKeyTable: () => ({}),
  getAvailableModels: (...a: unknown[]) => mocks.getAvailableModels(...a),
  getSupersededModels: (...a: unknown[]) => mocks.getSupersededModels(...a),
}));
vi.mock('@bike4mind/services', () => ({
  apiKeyService: { getEffectiveLLMApiKeys: vi.fn(async () => ({})) },
}));
// The real predicates, so the gate rule is exercised as production applies it; only the settings read is faked.
vi.mock('@bike4mind/services/llm/modelAdmission', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/services/llm/modelAdmission')>()),
  loadFreeTierAllowedModels: (...a: unknown[]) => mocks.loadFreeTierAllowedModels(...a),
}));
vi.mock('@server/entitlements', () => ({
  getUserEntitlements: (...a: unknown[]) => mocks.getUserEntitlements(...a),
  toEntitlementUser: (user: unknown) => user,
}));
vi.mock('@bike4mind/database', () => ({
  apiKeyRepository: {},
  adminSettingsRepository: { findOne: (...a: unknown[]) => mocks.findAdminSetting(...a) },
  cacheRepository: { findOne: vi.fn(async () => null), createOrUpdate: vi.fn(async () => undefined) },
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

  it('lists explicitly allowlisted media for a free user', async () => {
    mocks.loadFreeTierAllowedModels.mockResolvedValue(new Set(['priced', 'image-model']));

    expect(await listedIds()).toEqual(['priced', 'image-model']);
  });

  it('moves paid-only text models to lockedModels, marked locked, for a free user', async () => {
    const list = await callerList(makeUser());

    expect(list.lockedModels.map(model => model.id)).toEqual(['free']);
    expect(list.lockedModels.every(model => model.access?.locked === true)).toBe(true);
    expect(list.lockedModels[0].access?.reason).toBe('requires_paid_plan');
    expect(list.models.some(model => model.access)).toBe(false);
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
