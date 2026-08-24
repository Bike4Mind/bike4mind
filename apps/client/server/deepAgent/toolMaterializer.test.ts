import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Logger } from '@bike4mind/observability';
import type { ICompletionBackend } from '@bike4mind/llm-adapters';

// Collaborators of the materializer, stubbed so the REAL buildSharedTools still runs: a mocked
// builder could only prove the availability map was passed, not that an unavailable tool fails to
// materialize. resolveToolAvailability IS mocked - the point here is the wiring around it (which
// identity it is asked about, and that its answer is enforced), not its own key lookups, which
// b4m-core/services/src/llm/toolAvailability.test.ts already covers.
const resolveToolAvailabilityMock = vi.fn();

vi.mock('sst', () => ({ Resource: { ImageProcessor: { name: 'image-processor' } } }));
vi.mock('@bike4mind/services', async importOriginal => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, resolveToolAvailability: (...args: unknown[]) => resolveToolAvailabilityMock(...args) };
});
vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: vi.fn().mockResolvedValue({ _id: 'owner-1', id: 'owner-1' }) },
  adminSettingsRepository: {},
  apiKeyRepository: {},
  dataLakeRepository: {},
  fallbackLakeSettingsRepository: {},
  // ToolContext.db.organizations is required since #1674 (org membership set).
  organizationRepository: { findMembershipOrgIds: vi.fn().mockResolvedValue([]) },
  fabFileChunkRepository: {},
  fabFileRepository: {},
  imageModerationIncidentRepository: {},
  projectRepository: {},
  lakeAccessEventRepository: {},
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
});
