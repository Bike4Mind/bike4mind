import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./listUsableMusicModels', () => ({ listUsableMusicModels: vi.fn() }));
vi.mock('@bike4mind/services/musicJobs', () => ({ createMusicJob: vi.fn() }));

import { createMusicJob } from '@bike4mind/services/musicJobs';
import { isMusicToolConfig } from '@bike4mind/services/llm/tools';
import { buildMusicToolConfig } from './buildMusicToolConfig';
import { listUsableMusicModels } from './listUsableMusicModels';

const deps = { availability: {} as never, createDeps: { tag: 'create-deps' } as never };
const input = {
  user: { id: 'u1', organizationId: 'org-1' },
  request: { model: 'test-music', prompt: 'p' },
  source: 'agent' as const,
  sessionId: 'session-1',
  questId: 'quest-1',
  idempotencyKey: 'agent:u1:quest-1:abc',
};

describe('buildMusicToolConfig', () => {
  beforeEach(() => {
    vi.mocked(listUsableMusicModels).mockReset();
    vi.mocked(createMusicJob).mockReset();
  });

  it('returns null when no model is usable, which the tool gate rejects', async () => {
    vi.mocked(listUsableMusicModels).mockResolvedValue([]);
    const config = await buildMusicToolConfig('u1', deps);
    expect(config).toBeNull();
    expect(isMusicToolConfig(config)).toBe(false);
  });

  it('exposes usable model ids in catalog order as a config the tool gate accepts', async () => {
    vi.mocked(listUsableMusicModels).mockResolvedValue([{ id: 'music_v2' }, { id: 'test-music' }] as never);
    const config = await buildMusicToolConfig('u1', deps);
    expect(config?.usableModels).toEqual(['test-music', 'music_v2']);
    expect(isMusicToolConfig(config)).toBe(true);
  });

  it('passes the input through to createMusicJob with the engine deps', async () => {
    vi.mocked(listUsableMusicModels).mockResolvedValue([{ id: 'test-music' }] as never);
    vi.mocked(createMusicJob).mockResolvedValue({ ok: true, job: { id: 'job-1' } } as never);
    const config = await buildMusicToolConfig('u1', deps);

    const result = await config?.createJob(input);

    expect(createMusicJob).toHaveBeenCalledWith(input, deps.createDeps);
    expect(result).toEqual({ ok: true, job: { id: 'job-1' } });
  });
});
