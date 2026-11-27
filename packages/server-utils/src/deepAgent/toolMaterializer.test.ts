import { createHmac } from 'crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Resource } from 'sst';
import { Logger } from '@bike4mind/observability';
import { usdToCredits } from '@bike4mind/utils';
import type { ICompletionBackend } from '@bike4mind/llm-adapters';
import { URL_NOT_IN_CONVERSATION_MESSAGE, type ToolBuilderDeps } from '@bike4mind/services/llm';

// Collaborators of the materializer, stubbed so the REAL buildSharedTools still runs: a mocked
// builder could only prove the availability map was passed, not that an unavailable tool fails to
// materialize. resolveToolAvailability IS mocked - the point here is the wiring around it (which
// identity it is asked about, and that its answer is enforced), not its own key lookups, which
// b4m-core/services/src/llm/toolAvailability.test.ts already covers.
const resolveToolAvailabilityMock = vi.fn();
const buildSharedToolsSpy = vi.hoisted(() => vi.fn());
const getUserEntitlements = vi.hoisted(() => vi.fn(async (_user: unknown) => ['plan:paid']));
vi.mock('../entitlements/index', () => ({ getUserEntitlements }));

vi.mock('sst', () => ({
  Resource: { ImageProcessor: { name: 'image-processor' }, SECRET_ENCRYPTION_KEY: { value: 'test-secret' } },
}));
vi.mock('@bike4mind/services/llm', async importOriginal => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    resolveToolAvailability: (...args: unknown[]) => resolveToolAvailabilityMock(...args),
    buildSharedTools: (...args: unknown[]) => {
      buildSharedToolsSpy(...args);
      return (actual.buildSharedTools as (...a: unknown[]) => unknown)(...args);
    },
  };
});
vi.mock('@bike4mind/database', () => ({
  memoryLedgerRepository: { markSourceShredded: vi.fn().mockResolvedValue(0) },
  userRepository: {
    findById: vi.fn().mockResolvedValue({ _id: 'owner-1', id: 'owner-1' }),
    incrementCurrentStorage: vi.fn().mockResolvedValue(undefined),
  },
  // Lakes disabled, so the save tool answers right after its adapter gate without writing.
  adminSettingsRepository: { getSettingsValue: vi.fn().mockResolvedValue(false) },
  apiKeyRepository: {},
  spendFreezeRepository: { findActiveForSubject: vi.fn().mockResolvedValue(null) },
  cacheRepository: {},
  dataLakeRepository: {
    findByDatalakeTags: vi.fn().mockResolvedValue([]),
    findBySlug: vi.fn(),
    findBySlugAmongIds: vi.fn(),
    setStats: vi.fn(),
    activateIfDraft: vi.fn(),
  },
  dataLakeAccessGrantRepository: { listActiveByLakes: vi.fn().mockResolvedValue([]), listByLake: vi.fn() },
  fallbackLakeSettingsRepository: {},
  // ToolContext.db.organizations is required since #1674 (org membership set).
  organizationRepository: {
    findById: vi.fn().mockResolvedValue(null),
    findMembershipOrgIds: vi.fn().mockResolvedValue([]),
    incrementCurrentStorage: vi.fn().mockResolvedValue(undefined),
  },
  fabFileChunkRepository: {},
  fabFileRepository: {},
  imageModerationIncidentRepository: {},
  projectRepository: {},
  questRepository: { findSessionIdsByImage: vi.fn() },
  sessionRepository: { findAllByIds: vi.fn() },
  lakeAccessEventRepository: {},
  lakeMembershipRemovalRepository: {},
  lakeConfigChangeEventRepository: {},
  lakeMembershipChangeEventRepository: {},
  scopedSettingsRepository: {},
}));
vi.mock('@bike4mind/llm-adapters', async importOriginal => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, getAvailableModels: vi.fn().mockResolvedValue([]) };
});
vi.mock('../generationJobs/audioJobWiring', () => ({ buildAudioToolJobs: () => ({}) }));
vi.mock('./resolveBackend', () => ({
  buildSystemApiKeyTable: vi.fn().mockResolvedValue({}),
}));
vi.mock('../utils/storage/index', () => ({
  getFilesStorage: () => ({}),
  getGeneratedImageStorage: () => ({}),
}));

const billing = vi.hoisted(() => ({
  enforced: false,
  usd: 0.04,
  isCreditsEnforced: vi.fn(),
  reserve: vi.fn(),
  settle: vi.fn(),
  estimate: vi.fn(),
  capExceeded: vi.fn(),
}));
vi.mock('../billing/meterPlatformCompletion', () => ({
  isCreditsEnforced: billing.isCreditsEnforced,
  reserveCompletionCredits: billing.reserve,
  settleCompletion: billing.settle,
}));
vi.mock('@bike4mind/services', async importOriginal => {
  const actual = (await importOriginal()) as Record<string, unknown> & { creditService: Record<string, unknown> };
  return {
    ...actual,
    estimateGeneratedMediaUsd: billing.estimate,
    creditService: { ...actual.creditService, isMemberCreditCapExceeded: billing.capExceeded },
  };
});

const { createDeepAgentToolMaterializer } = await import('./toolMaterializer');
const { organizationRepository, questRepository, sessionRepository, spendFreezeRepository, userRepository } =
  await import('@bike4mind/database');

// A minimal backend stand-in; never invoked by the paths under test.
const fakeLlm = { complete: vi.fn() } as unknown as ICompletionBackend;

const materialize = () => createDeepAgentToolMaterializer({ llm: fakeLlm, model: 'fake-model', logger: new Logger() });

describe('createDeepAgentToolMaterializer', () => {
  beforeEach(() => {
    getUserEntitlements.mockClear();
    resolveToolAvailabilityMock.mockReset();
    resolveToolAvailabilityMock.mockResolvedValue({});
  });

  it('short-circuits to no tools for an empty profile (no DB / storage access)', async () => {
    // Empty enabledToolNames must return [] before touching the owner user,
    // api-key table, storage, or buildSharedTools.
    await expect(materialize()([], 'owner-1')).resolves.toEqual([]);
    expect(resolveToolAvailabilityMock).not.toHaveBeenCalled();
  });

  it('lets web_fetch open only URLs from the charter text', async () => {
    const tools = await materialize()(['web_fetch'], 'owner-1', ['Track https://paper.test/a']);
    const toolDeps = buildSharedToolsSpy.mock.calls[0][0] as ToolBuilderDeps;
    expect(toolDeps.urlProvenance?.allows('https://paper.test/a')).toBe(true);

    const webFetch = tools.find(tool => tool.toolSchema.name === 'web_fetch');
    await expect(webFetch!.toolFn({ url: 'https://paper.test/a?d=secret' })).rejects.toThrow(
      URL_NOT_IN_CONVERSATION_MESSAGE
    );
  });

  it('resolves current owner entitlements lazily without precomputed keys', async () => {
    await materialize()(['dice_roll'], 'owner-1');
    const toolDeps = buildSharedToolsSpy.mock.calls[0][0] as {
      getEntitlements: () => Promise<string[]>;
      entitlementKeys?: string[];
    };
    expect(toolDeps.entitlementKeys).toBeUndefined();
    expect(getUserEntitlements).not.toHaveBeenCalled();
    await expect(toolDeps.getEntitlements()).resolves.toEqual(['plan:paid']);
    expect(getUserEntitlements).toHaveBeenCalledExactlyOnceWith({ _id: 'owner-1', id: 'owner-1' });
  });

  it("withholds built-in tools the owner's billing org policy does not allow", async () => {
    vi.mocked(userRepository.findById).mockResolvedValueOnce({
      _id: 'owner-1',
      id: 'owner-1',
      organizationId: 'org-1',
    } as never);
    vi.mocked(organizationRepository.findById).mockResolvedValueOnce({
      id: 'org-1',
      modelPolicy: { allowedTools: ['dice_roll'] },
    } as never);
    const tools = await materialize()(['weather_info', 'dice_roll'], 'owner-1');
    expect(organizationRepository.findById).toHaveBeenCalledWith('org-1');
    expect(tools.map(t => t.toolSchema.name)).toEqual(['dice_roll']);
    const opts = buildSharedToolsSpy.mock.calls.at(-1)?.[2] as { orgToolPolicy?: unknown };
    expect(opts.orgToolPolicy).toMatchObject({ allowedTools: ['dice_roll'] });
  });

  it('resolves availability for the OWNER, fail-closed', async () => {
    // The api-key table this path builds belongs to the 'system' identity and backs only the model;
    // the tools resolve their own keys as the owner, so asking about 'system' would gate on keys the
    // tools never use.
    await materialize()(['weather_info'], 'owner-1');
    expect(resolveToolAvailabilityMock).toHaveBeenCalledWith(
      'owner-1',
      expect.anything(),
      expect.objectContaining({ onLookupError: 'unavailable' })
    );
  });

  it('never materializes a key-gated tool the owner has no working key for', async () => {
    resolveToolAvailabilityMock.mockResolvedValue({ weather_info: false });
    const tools = await materialize()(['weather_info', 'dice_roll'], 'owner-1');
    const names = tools.map(t => t.toolSchema.name);
    expect(names).not.toContain('weather_info');
    expect(names).toContain('dice_roll');
  });

  it('materializes a key-gated tool whose key resolves', async () => {
    resolveToolAvailabilityMock.mockResolvedValue({ weather_info: true });
    const tools = await materialize()(['weather_info', 'dice_roll'], 'owner-1');
    expect(tools.map(t => t.toolSchema.name)).toEqual(expect.arrayContaining(['weather_info', 'dice_roll']));
  });

  it('threads the real signing secret into web_search config so its image cards can verify', async () => {
    await materialize()(['web_search'], 'owner-1');
    const opts = buildSharedToolsSpy.mock.calls[0]?.[2] as {
      config?: { web_search?: { imageUrlSigningSecret?: string } };
    };
    expect(opts?.config?.web_search?.imageUrlSigningSecret).toBe('test-secret');
  });

  it('signs web_search image URLs with the derived key when a dedicated signing secret is set', async () => {
    const resource = Resource as unknown as Record<string, unknown>;
    buildSharedToolsSpy.mockClear();
    resource.HMAC_SIGNING_SECRET = { value: 'test-dedicated-secret' };
    try {
      await materialize()(['web_search'], 'owner-1');
    } finally {
      delete resource.HMAC_SIGNING_SECRET;
    }
    const opts = buildSharedToolsSpy.mock.calls[0]?.[2] as {
      config?: { web_search?: { imageUrlSigningSecret?: string } };
    };
    expect(opts?.config?.web_search?.imageUrlSigningSecret).toBe(
      createHmac('sha256', 'test-dedicated-secret').update('b4m-signing/search-image-url/v1').digest('hex')
    );
    expect(opts?.config?.web_search?.imageUrlSigningSecret).not.toBe('test-secret');
  });

  it('marks the tool deps as internal-origin with no api key', async () => {
    await materialize()(['dice_roll'], 'owner-1');
    const toolDeps = buildSharedToolsSpy.mock.calls[0]?.[0] as { authOrigin?: string; apiKeyId?: string };
    expect(toolDeps.authOrigin).toBe('internal');
    expect(toolDeps.apiKeyId).toBeUndefined();
  });

  it('wires the owner lookup edit_image needs for generated-image keys', async () => {
    // Without it the resolver fails closed, so owners are refused with only a logged warning.
    await materialize()(['edit_image'], 'owner-1');
    const toolDeps = buildSharedToolsSpy.mock.calls[0]?.[0] as {
      db: { quests?: unknown; sessions?: { findAllByIds: (ids: string[]) => unknown } };
    };
    expect(toolDeps.db.quests).toBe(questRepository);
    // Narrow by design: only the lookup, never incrementImageCount.
    expect(Object.keys(toolDeps.db.sessions ?? {})).toEqual(['findAllByIds']);
    toolDeps.db.sessions?.findAllByIds(['s1']);
    expect(sessionRepository.findAllByIds).toHaveBeenCalledWith(['s1']);
  });

  it('hands the lake write tools their audit adapters and no organization', async () => {
    const tools = await materialize()(['save_content_to_data_lake'], 'owner-1');
    const toolDeps = buildSharedToolsSpy.mock.calls[0]?.[0] as { db: Record<string, unknown>; organizationId?: string };
    expect(toolDeps.db.lakeMembershipRemovals).toBeDefined();
    expect(toolDeps.db.lakeConfigChangeEvents).toBeDefined();
    expect(toolDeps.db.lakeMembershipChangeEvents).toBeDefined();
    expect(toolDeps.organizationId).toBeUndefined();

    const save = tools.find(t => t.toolSchema.name === 'save_content_to_data_lake');
    const reply = await save?.toolFn({ content: 'hello', fileName: 'note.md', dataLakeId: 'lake-1' });
    expect(reply).not.toMatch(/not available on this surface/);
    expect(reply).toMatch(/Data lakes are not enabled/);
  });
});

describe('deep agent media tools', () => {
  type Callbacks = {
    onToolStart: (n: string, d: unknown) => Promise<void>;
    onToolFinish: (n: string, d: unknown) => Promise<void>;
  };
  const callbacksFor = async () => {
    buildSharedToolsSpy.mockClear();
    await materialize()(['edit_image'], 'owner-1');
    return buildSharedToolsSpy.mock.calls[0][1] as Callbacks;
  };
  const toolNamed = async (name: string) => {
    const tool = (await materialize()([name], 'owner-1')).find(t => t.toolSchema.name === name);
    if (!tool) throw new Error(`${name} did not materialize`);
    return tool;
  };
  const EDIT = { model: 'image-model', n: 1 };

  beforeEach(() => {
    resolveToolAvailabilityMock.mockResolvedValue({});
    billing.isCreditsEnforced.mockReset().mockImplementation(async () => billing.enforced);
    billing.estimate.mockReset().mockImplementation(() => billing.usd);
    billing.capExceeded.mockReset().mockReturnValue(false);
    billing.reserve.mockReset().mockResolvedValue({ settle: vi.fn() });
    billing.settle.mockReset().mockResolvedValue(1);
    billing.enforced = false;
    billing.usd = 0.04;
  });

  // image_generation with no preset model answers with its model picker before onToolStart, so the
  // standing check has to sit on the tool call itself; these drive the materialized tool, not the callbacks.
  describe('the materialized image_generation call', () => {
    it('refuses a restricted owner', async () => {
      const tool = await toolNamed('image_generation');
      vi.mocked(userRepository.findById).mockResolvedValueOnce({ id: 'owner-1', isModerated: true } as never);

      await expect(tool.toolFn({ prompt: 'a lighthouse' })).rejects.toMatchObject({ statusCode: 403 });
      expect(billing.reserve).not.toHaveBeenCalled();
    });

    it('runs for an owner in good standing', async () => {
      const tool = await toolNamed('image_generation');
      vi.mocked(userRepository.findById).mockResolvedValueOnce({ id: 'owner-1' } as never);

      await expect(tool.toolFn({ prompt: 'a lighthouse' })).resolves.toMatch(/model selection required/i);
    });

    it('runs concurrent media calls one at a time', async () => {
      const tool = await toolNamed('image_generation');
      let release!: (owner: unknown) => void;
      vi.mocked(userRepository.findById)
        .mockClear()
        .mockImplementationOnce(() => new Promise(resolve => (release = resolve)) as never);

      const first = tool.toolFn({ prompt: 'one' });
      const second = tool.toolFn({ prompt: 'two' });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(userRepository.findById).toHaveBeenCalledTimes(1);

      release({ id: 'owner-1' });
      await Promise.all([first, second]);
      expect(vi.mocked(userRepository.findById).mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('refuses an owner who cannot cover the media estimate when credits are enforced', async () => {
    billing.enforced = true;
    const callbacks = await callbacksFor();
    vi.mocked(userRepository.findById).mockResolvedValueOnce({ id: 'owner-1', currentCredits: 0 } as never);

    await expect(callbacks.onToolStart('edit_image', EDIT)).rejects.toMatchObject({ statusCode: 422 });
  });

  it('refuses an org member whose credit cap the estimate would pass', async () => {
    billing.enforced = true;
    billing.capExceeded.mockReturnValue(true);
    const member = { id: 'owner-1', organizationId: 'org-1' };
    vi.mocked(userRepository.findById).mockResolvedValue(member as never);
    vi.mocked(organizationRepository.findById).mockResolvedValue({ id: 'org-1', currentCredits: 1_000_000 } as never);
    try {
      const callbacks = await callbacksFor();

      await expect(callbacks.onToolStart('edit_image', EDIT)).rejects.toMatchObject({ statusCode: 422 });
      expect(billing.capExceeded).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'org-1' }),
        'owner-1',
        usdToCredits(0.04)
      );
    } finally {
      vi.mocked(userRepository.findById).mockResolvedValue({ _id: 'owner-1', id: 'owner-1' } as never);
      vi.mocked(organizationRepository.findById).mockResolvedValue(null);
    }
  });

  it('lets an affordable owner through when credits are enforced', async () => {
    billing.enforced = true;
    const callbacks = await callbacksFor();
    vi.mocked(userRepository.findById).mockResolvedValueOnce({ id: 'owner-1', currentCredits: 1_000_000 } as never);

    await expect(callbacks.onToolStart('edit_image', EDIT)).resolves.toBeUndefined();
  });

  it('refuses a media call for a frozen owner before any estimate, even when credits are not enforced', async () => {
    const callbacks = await callbacksFor();
    vi.mocked(spendFreezeRepository.findActiveForSubject).mockResolvedValueOnce({
      scopeType: 'User',
      scopeId: 'owner-1',
      frozenAt: new Date('2026-11-16T00:00:00Z'),
    } as never);

    await expect(callbacks.onToolStart('edit_image', EDIT)).rejects.toMatchObject({
      statusCode: 403,
      additionalInfo: { errorCode: 'spend_frozen' },
    });
    expect(spendFreezeRepository.findActiveForSubject).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'owner-1' })
    );
    expect(billing.estimate).not.toHaveBeenCalled();
  });

  it('skips the credit check when credits are not enforced', async () => {
    const callbacks = await callbacksFor();

    await expect(callbacks.onToolStart('edit_image', EDIT)).resolves.toBeUndefined();
    expect(billing.estimate).not.toHaveBeenCalled();
  });

  it('charges a delivered edit once, at the estimated cost, to the owner', async () => {
    const callbacks = await callbacksFor();

    await callbacks.onToolFinish('edit_image', EDIT);

    expect(billing.reserve).toHaveBeenCalledTimes(1);
    expect(billing.reserve.mock.calls[0][1]).toBe(0.04);
    expect(billing.settle).toHaveBeenCalledTimes(1);
    expect(billing.settle.mock.calls[0][2]).toMatchObject({ model: 'image-model', usd: 0.04, inputTokens: 0 });
  });

  it('labels a delivered sound effect by its kind, since it reports no model', async () => {
    const callbacks = await callbacksFor();

    await callbacks.onToolFinish('audio_generation', {
      kind: 'sound_effect',
      provider: 'sfx-vendor',
      durationSeconds: 3,
    });

    expect(billing.settle.mock.calls[0][2]).toMatchObject({ model: 'sound_effect', provider: 'sfx-vendor', usd: 0.04 });
  });

  it('logs rather than throws when the charge for delivered media is refused', async () => {
    billing.reserve.mockRejectedValueOnce(new Error('insufficient credits'));
    const callbacks = await callbacksFor();

    await expect(callbacks.onToolFinish('edit_image', EDIT)).resolves.toBeUndefined();
    expect(billing.settle).not.toHaveBeenCalled();
  });

  it('leaves non-media tools alone', async () => {
    const callbacks = await callbacksFor();
    vi.mocked(userRepository.findById).mockClear();

    await callbacks.onToolStart('weather_info', {});
    await callbacks.onToolFinish('weather_info', {});

    expect(userRepository.findById).not.toHaveBeenCalled();
    expect(billing.reserve).not.toHaveBeenCalled();
  });

  it('does not charge a media call that never finished', async () => {
    const callbacks = await callbacksFor();

    await callbacks.onToolStart('edit_image', EDIT);

    expect(billing.reserve).not.toHaveBeenCalled();
    expect(billing.settle).not.toHaveBeenCalled();
  });
});
