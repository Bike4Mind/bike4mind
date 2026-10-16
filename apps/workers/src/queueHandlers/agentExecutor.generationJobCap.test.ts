import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from '@bike4mind/observability';

// Each production deps factory wires a job kind and a settings key by hand, so a swapped kind or key
// still typechecks and the pure-half tests stay green. Pin them here.

const h = vi.hoisted(() => ({
  claimAgentGenerationSlot: vi.fn(async (_questId: string, _kind: string, _limit: number) => true),
  releaseAgentGenerationSlot: vi.fn(async (_questId: string, _kind: string) => undefined),
  resolveScopedSetting: vi.fn(async (_key: string, _scope: unknown, _db: unknown, _opts?: unknown) => ({ value: 7 })),
  scopeForCaller: vi.fn((caller: { userId: string; organizationId?: string | null }) => ({
    organizationId: caller.organizationId || undefined,
  })),
}));

vi.mock('@bike4mind/database', () => ({
  questRepository: {
    claimAgentGenerationSlot: h.claimAgentGenerationSlot,
    releaseAgentGenerationSlot: h.releaseAgentGenerationSlot,
  },
  adminSettingsRepository: {},
  scopedSettingsRepository: {},
}));

vi.mock('@bike4mind/services', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/services')>('@bike4mind/services');
  return {
    ...actual,
    scopedSettingsService: { resolveScopedSetting: h.resolveScopedSetting, scopeForCaller: h.scopeForCaller },
  };
});

vi.mock('@server/generationJobs/wiring', () => ({
  getMusicJobDeps: vi.fn(),
  getCreateMusicJobDeps: vi.fn(),
  getVideoJobDeps: vi.fn(),
  getCreateVideoJobDeps: vi.fn(),
}));
vi.mock('@server/musicGenerations/buildMusicToolConfig', () => ({ buildMusicToolConfig: vi.fn() }));
vi.mock('@server/videoGenerations/buildVideoToolConfig', () => ({ buildVideoToolConfig: vi.fn() }));

const { getAgentMusicToolConfigDeps } = await import('./agentExecutor.musicToolConfig');
const { getAgentVideoToolConfigDeps } = await import('./agentExecutor.videoToolConfig');

const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

beforeEach(() => {
  vi.clearAllMocks();
  h.claimAgentGenerationSlot.mockResolvedValue(true);
  h.releaseAgentGenerationSlot.mockResolvedValue(undefined);
  h.resolveScopedSetting.mockResolvedValue({ value: 7 });
});

describe('production generation deps factories', () => {
  it('counts music on the music counter, via the music Quest', async () => {
    const deps = getAgentMusicToolConfigDeps(logger);

    await deps.slots.claim('q-1', 3);
    await deps.slots.release('q-1');

    expect(h.claimAgentGenerationSlot).toHaveBeenCalledWith('q-1', 'music', 3);
    expect(h.releaseAgentGenerationSlot).toHaveBeenCalledWith('q-1', 'music');
  });

  it('counts video on the video counter, via the video Quest', async () => {
    const deps = getAgentVideoToolConfigDeps(logger);

    await deps.slots.claim('q-1', 2);
    await deps.slots.release('q-1');

    expect(h.claimAgentGenerationSlot).toHaveBeenCalledWith('q-1', 'video', 2);
    expect(h.releaseAgentGenerationSlot).toHaveBeenCalledWith('q-1', 'video');
  });

  it('reads the music setting key for the run org and returns its value', async () => {
    const deps = getAgentMusicToolConfigDeps(logger);

    await expect(deps.resolveTrackLimit({ userId: 'u-1', organizationId: 'org-1' })).resolves.toBe(7);

    expect(h.scopeForCaller).toHaveBeenCalledWith({ userId: 'u-1', organizationId: 'org-1' });
    expect(h.resolveScopedSetting.mock.calls[0]?.[0]).toBe('agentMusicTracksPerRun');
  });

  it('reads the video setting key for the run org and returns its value', async () => {
    const deps = getAgentVideoToolConfigDeps(logger);

    await expect(deps.resolveClipLimit({ userId: 'u-1', organizationId: 'org-1' })).resolves.toBe(7);

    expect(h.scopeForCaller).toHaveBeenCalledWith({ userId: 'u-1', organizationId: 'org-1' });
    expect(h.resolveScopedSetting.mock.calls[0]?.[0]).toBe('agentVideoClipsPerRun');
  });
});
