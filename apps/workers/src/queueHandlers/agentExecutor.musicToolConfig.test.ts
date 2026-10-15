import { describe, it, expect, vi } from 'vitest';
import type { MusicToolConfig } from '@bike4mind/services/llm/tools';

vi.mock('@server/generationJobs/wiring', () => ({ getMusicJobDeps: vi.fn(), getCreateMusicJobDeps: vi.fn() }));
vi.mock('@server/musicGenerations/buildMusicToolConfig', () => ({ buildMusicToolConfig: vi.fn() }));

const { buildAgentMusicToolConfig } = await import('./agentExecutor.musicToolConfig');

const base: MusicToolConfig = { usableModels: ['test-music'], createJob: vi.fn() };
const caller = { userId: 'user-1', questId: 'quest-1', toolEnabled: true };
const makeDeps = () => ({
  buildBaseConfig: vi.fn(async (): Promise<MusicToolConfig | null> => base),
  logger: { warn: vi.fn() } as never,
});

describe('buildAgentMusicToolConfig', () => {
  it('returns the base config for an enabled, session-started run with a quest', async () => {
    const deps = makeDeps();
    await expect(buildAgentMusicToolConfig(caller, deps)).resolves.toBe(base);
    expect(deps.buildBaseConfig).toHaveBeenCalledWith('user-1');
  });

  it.each([
    ['the tool is not in the toolbelt', { toolEnabled: false }],
    ['an API key started the run', { apiKeyId: 'key-1' }],
    ['the run has no quest', { questId: undefined }],
  ])('offers nothing when %s, without reading settings or keys', async (_case, override) => {
    const deps = makeDeps();
    await expect(buildAgentMusicToolConfig({ ...caller, ...override }, deps)).resolves.toBeNull();
    expect(deps.buildBaseConfig).not.toHaveBeenCalled();
  });

  it('fails closed and warns when the base config throws', async () => {
    const deps = makeDeps();
    deps.buildBaseConfig.mockRejectedValueOnce(new Error('settings read failed'));
    await expect(buildAgentMusicToolConfig(caller, deps)).resolves.toBeNull();
    expect(deps.logger.warn).toHaveBeenCalled();
  });
});
