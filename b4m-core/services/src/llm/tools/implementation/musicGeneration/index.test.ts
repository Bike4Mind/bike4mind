import { describe, expect, it, vi } from 'vitest';
import { musicGenerationTool, isMusicToolConfig, type MusicToolConfig } from './index';

const okJob = { ok: true as const, created: true, job: { id: 'job1' } };

type BuildOptions = { questId?: string; usableModels?: MusicToolConfig['usableModels'] };

const build = (createJob: MusicToolConfig['createJob'], options: BuildOptions = {}) => {
  const { usableModels = ['test-music'] } = options;
  const questId = 'questId' in options ? options.questId : 'q1';
  const statusUpdate = vi.fn().mockResolvedValue(undefined);
  const onStart = vi.fn();
  const onFinish = vi.fn();
  const config: MusicToolConfig = { usableModels, createJob };
  const context = {
    userId: 'u1',
    organizationId: 'org1',
    sessionId: 's1',
    questId,
    statusUpdate,
    onStart,
    onFinish,
  } as never;
  return { tool: musicGenerationTool.implementation(context, config), statusUpdate, onStart, onFinish };
};

describe('music_generation tool', () => {
  it('starts an agent-sourced job for the notebook and message, and returns the job id with an estimate', async () => {
    const createJob = vi.fn().mockResolvedValue(okJob);
    const { tool, statusUpdate } = build(createJob);
    const result = JSON.parse(await tool.toolFn({ model: 'test-music', prompt: 'a sea shanty' }));
    expect(result).toEqual({ jobId: 'job1', estimatedSeconds: 2 });
    expect(createJob.mock.calls[0][0]).toMatchObject({
      source: 'agent',
      sessionId: 's1',
      questId: 'q1',
      user: { id: 'u1', organizationId: 'org1' },
      request: { model: 'test-music', prompt: 'a sea shanty' },
    });
    expect(statusUpdate).toHaveBeenCalledWith({ generationJobs: [{ id: 'job1', kind: 'music' }] });
  });

  it('passes lyrics, instrumental and length through and leaves omitted fields to the job', async () => {
    const createJob = vi.fn().mockResolvedValue(okJob);
    const { tool } = build(createJob);
    await tool.toolFn({ model: 'test-music', prompt: 'p', lyrics: '[Verse]\nla la', durationSeconds: 10 });
    await tool.toolFn({ model: 'test-music', prompt: 'p', instrumental: true });
    expect(createJob.mock.calls[0][0].request).toEqual({
      model: 'test-music',
      prompt: 'p',
      lyrics: '[Verse]\nla la',
      durationSeconds: 10,
    });
    expect(createJob.mock.calls[1][0].request).toEqual({ model: 'test-music', prompt: 'p', instrumental: true });
  });

  it('returns a readable refusal without a card when the job is refused', async () => {
    const createJob = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      code: 'unsupported_duration',
      message: 'duration 20s is not supported',
    });
    const { tool, statusUpdate } = build(createJob);
    const result = await tool.toolFn({ model: 'test-music', prompt: 'p', durationSeconds: 20 });
    expect(result).toBe('Music generation failed (unsupported_duration): duration 20s is not supported');
    expect(statusUpdate).not.toHaveBeenCalled();
  });

  it('refuses to report an idempotent replay of a job that already ended without a song', async () => {
    const createJob = vi.fn().mockResolvedValue({
      ok: true,
      created: false,
      job: { id: 'job1', state: 'failed', error: { code: 'provider_error', message: 'boom' } },
    });
    const { tool, statusUpdate } = build(createJob);
    const result = await tool.toolFn({ model: 'test-music', prompt: 'p' });
    expect(result).toBe('Music generation failed (provider_error): an identical request already ended without a song.');
    expect(statusUpdate).not.toHaveBeenCalled();
  });

  it('still reports an idempotent replay of a job that already succeeded', async () => {
    const createJob = vi.fn().mockResolvedValue({ ok: true, created: false, job: { id: 'job1', state: 'succeeded' } });
    const { tool, statusUpdate } = build(createJob);
    const result = JSON.parse(await tool.toolFn({ model: 'test-music', prompt: 'p' }));
    expect(result).toEqual({ jobId: 'job1', estimatedSeconds: 2 });
    expect(statusUpdate).toHaveBeenCalledWith({ generationJobs: [{ id: 'job1', kind: 'music' }] });
  });

  // The dead-job guard only applies to a replay: a job created now must show its card even if it is already terminal.
  it('still reports a freshly created job that is already terminal', async () => {
    const createJob = vi.fn().mockResolvedValue({ ok: true, created: true, job: { id: 'job1', state: 'blocked' } });
    const { tool, statusUpdate } = build(createJob);
    const result = JSON.parse(await tool.toolFn({ model: 'test-music', prompt: 'p' }));
    expect(result).toEqual({ jobId: 'job1', estimatedSeconds: 2 });
    expect(statusUpdate).toHaveBeenCalledWith({ generationJobs: [{ id: 'job1', kind: 'music' }] });
  });

  it('rejects a model the caller cannot use before starting a job', async () => {
    const createJob = vi.fn().mockResolvedValue(okJob);
    const { tool } = build(createJob);
    await expect(tool.toolFn({ model: 'lyria-3.5', prompt: 'p' })).rejects.toThrow();
    expect(createJob).not.toHaveBeenCalled();
  });

  it('uses a stable idempotency key per quest and request, and none without a quest', async () => {
    const createJob = vi.fn().mockResolvedValue(okJob);
    const { tool } = build(createJob);
    await tool.toolFn({ model: 'test-music', prompt: 'p' });
    await tool.toolFn({ model: 'test-music', prompt: 'p' });
    const [first, second] = createJob.mock.calls.map(call => call[0].idempotencyKey);
    expect(first).toMatch(/^agent:u1:q1:[0-9a-f]{32}$/);
    expect(second).toBe(first);

    const noQuest = vi.fn().mockResolvedValue(okJob);
    await build(noQuest, { questId: undefined }).tool.toolFn({ model: 'test-music', prompt: 'p' });
    expect(noQuest.mock.calls[0][0].idempotencyKey).toBeUndefined();
  });

  it('never bills through onStart/onFinish: the job holds and settles the credits', async () => {
    const { tool, onStart, onFinish } = build(vi.fn().mockResolvedValue(okJob));
    await tool.toolFn({ model: 'test-music', prompt: 'p' });
    expect(onStart).not.toHaveBeenCalled();
    expect(onFinish).not.toHaveBeenCalled();
  });

  it('propagates a createJob failure without emitting a card', async () => {
    const createJob = vi.fn().mockRejectedValue(new Error('db down'));
    const { tool, statusUpdate } = build(createJob);
    await expect(tool.toolFn({ model: 'test-music', prompt: 'p' })).rejects.toThrow('db down');
    expect(statusUpdate).not.toHaveBeenCalled();
  });

  // The job is created and billed before the card is announced, so a statusUpdate failure must not be swallowed:
  // the caller sees the error and the running job is left for the websocket/reload to pick up.
  it('propagates a statusUpdate failure after the job was created', async () => {
    const createJob = vi.fn().mockResolvedValue(okJob);
    const { tool, statusUpdate } = build(createJob);
    statusUpdate.mockRejectedValue(new Error('socket closed'));
    await expect(tool.toolFn({ model: 'test-music', prompt: 'p' })).rejects.toThrow('socket closed');
    expect(createJob).toHaveBeenCalledTimes(1);
  });

  it('offers only the usable models in a plain JSON Schema', () => {
    const { tool } = build(vi.fn(), { usableModels: ['test-music', 'music_v2'] });
    const { parameters } = tool.toolSchema;
    expect(parameters).not.toHaveProperty('$schema');
    expect(parameters.properties.model).toMatchObject({ enum: ['test-music', 'music_v2'] });
  });

  it('builds an inert tool when no config is wired', async () => {
    const tool = musicGenerationTool.implementation({ userId: 'u1' } as never, undefined);
    expect(await tool.toolFn({})).toContain('not available');
  });

  it('rejects an empty or malformed config', () => {
    expect(isMusicToolConfig({ usableModels: [], createJob: vi.fn() })).toBe(false);
    expect(isMusicToolConfig({ usableModels: ['test-music'] })).toBe(false);
    expect(isMusicToolConfig(null)).toBe(false);
    expect(isMusicToolConfig({ usableModels: ['test-music'], createJob: vi.fn() })).toBe(true);
  });
});
