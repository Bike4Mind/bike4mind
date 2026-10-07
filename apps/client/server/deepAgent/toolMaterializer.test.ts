import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Logger } from '@bike4mind/observability';
import type { ICompletionBackend } from '@bike4mind/llm-adapters';

// Collaborators of the materializer, stubbed so the REAL buildSharedTools still runs: a mocked
// builder could only prove the availability map was passed, not that an unavailable tool fails to
// materialize. resolveToolAvailability IS mocked - the point here is the wiring around it (which
// identity it is asked about, and that its answer is enforced), not its own key lookups, which
// b4m-core/services/src/llm/toolAvailability.test.ts already covers.
const resolveToolAvailabilityMock = vi.fn();
const buildSharedToolsSpy = vi.hoisted(() => vi.fn());

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
  userRepository: { findById: vi.fn().mockResolvedValue({ _id: 'owner-1', id: 'owner-1' }) },
  // Lakes disabled, so the save tool answers right after its adapter gate without writing.
  adminSettingsRepository: { getSettingsValue: vi.fn().mockResolvedValue(false) },
  apiKeyRepository: {},
  dataLakeRepository: {
    findBySlug: vi.fn(),
    findBySlugAmongIds: vi.fn(),
    setStats: vi.fn(),
    activateIfDraft: vi.fn(),
  },
  dataLakeAccessGrantRepository: { listActiveByLakes: vi.fn().mockResolvedValue([]), listByLake: vi.fn() },
  fallbackLakeSettingsRepository: {},
  // ToolContext.db.organizations is required since #1674 (org membership set).
  organizationRepository: { findMembershipOrgIds: vi.fn().mockResolvedValue([]) },
  fabFileChunkRepository: {},
  fabFileRepository: {},
  imageModerationIncidentRepository: {},
  projectRepository: {},
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
vi.mock('./resolveBackend', () => ({ buildSystemApiKeyTable: vi.fn().mockResolvedValue({}) }));
vi.mock('@server/utils/storage', () => ({
  getFilesStorage: () => ({}),
  getGeneratedImageStorage: () => ({}),
}));

const { createDeepAgentToolMaterializer } = await import('./toolMaterializer');

// A minimal backend stand-in; never invoked by the paths under test.
const fakeLlm = { complete: vi.fn() } as unknown as ICompletionBackend;

const materialize = () => createDeepAgentToolMaterializer({ llm: fakeLlm, model: 'fake-model', logger: new Logger() });

describe('createDeepAgentToolMaterializer', () => {
  beforeEach(() => {
    resolveToolAvailabilityMock.mockReset();
    resolveToolAvailabilityMock.mockResolvedValue({});
  });

  it('short-circuits to no tools for an empty profile (no DB / storage access)', async () => {
    // Empty enabledToolNames must return [] before touching the owner user,
    // api-key table, storage, or buildSharedTools.
    await expect(materialize()([], 'owner-1')).resolves.toEqual([]);
    expect(resolveToolAvailabilityMock).not.toHaveBeenCalled();
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
