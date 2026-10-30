import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./listUsableVideoModels', () => ({ listUsableVideoModels: vi.fn() }));
vi.mock('@bike4mind/services/videoJobs', () => ({ createVideoJob: vi.fn() }));

import { createVideoJob } from '@bike4mind/services/videoJobs';
import { isVideoToolConfig } from '@bike4mind/services/llm/tools';
import { buildVideoToolConfig } from './buildVideoToolConfig';
import { listUsableVideoModels } from './listUsableVideoModels';

const deps = { availability: {} as never, createDeps: { tag: 'create-deps' } as never };
const input = {
  user: { id: 'u1', organizationId: 'org-1' },
  request: { model: 'test-video' },
  source: 'agent' as const,
  questId: 'quest-1',
  idempotencyKey: 'agent:u1:quest-1:abc',
};

describe('buildVideoToolConfig', () => {
  beforeEach(() => {
    vi.mocked(listUsableVideoModels).mockReset();
    vi.mocked(createVideoJob).mockReset();
  });

  it('returns null when no model is usable, which the tool gate rejects', async () => {
    vi.mocked(listUsableVideoModels).mockResolvedValue([]);
    const config = await buildVideoToolConfig('u1', deps);
    expect(config).toBeNull();
    expect(isVideoToolConfig(config)).toBe(false);
  });

  it('exposes usable model ids as a config the tool gate accepts', async () => {
    vi.mocked(listUsableVideoModels).mockResolvedValue([{ id: 'test-video' }] as never);
    const config = await buildVideoToolConfig('u1', deps);
    expect(config?.usableModels).toEqual(['test-video']);
    expect(isVideoToolConfig(config)).toBe(true);
  });

  it('passes source, questId, org and key through to createVideoJob with the engine deps', async () => {
    vi.mocked(listUsableVideoModels).mockResolvedValue([{ id: 'test-video' }] as never);
    vi.mocked(createVideoJob).mockResolvedValue({ ok: true, job: { id: 'job-1' } } as never);
    const config = await buildVideoToolConfig('u1', deps);

    const result = await config?.createJob(input);

    expect(createVideoJob).toHaveBeenCalledWith(input, deps.createDeps);
    expect(result).toEqual({ ok: true, job: { id: 'job-1' } });
  });

  it('returns a failed createVideoJob result instead of throwing', async () => {
    vi.mocked(listUsableVideoModels).mockResolvedValue([{ id: 'test-video' }] as never);
    const failure = { ok: false, code: 'insufficient_credits', message: 'no credits' };
    vi.mocked(createVideoJob).mockResolvedValue(failure as never);
    const config = await buildVideoToolConfig('u1', deps);

    await expect(config?.createJob(input)).resolves.toEqual(failure);
  });
});
