import { describe, expect, it, vi } from 'vitest';
import { videoGenerationTool, isVideoToolConfig, type VideoToolConfig } from './index';

const okJob = { ok: true as const, created: true, job: { id: 'job1' } };

const build = (createJob: VideoToolConfig['createJob'], { questId }: { questId?: string } = { questId: 'q1' }) => {
  const statusUpdate = vi.fn().mockResolvedValue(undefined);
  const onStart = vi.fn();
  const onFinish = vi.fn();
  const config: VideoToolConfig = { usableModels: ['test-video'], createJob };
  const context = { userId: 'u1', organizationId: null, questId, statusUpdate, onStart, onFinish } as never;
  return { tool: videoGenerationTool.implementation(context, config), statusUpdate, onStart, onFinish };
};

describe('video_generation tool', () => {
  it('starts an agent-sourced job and returns the job id with an estimate', async () => {
    const createJob = vi.fn().mockResolvedValue(okJob);
    const { tool, statusUpdate } = build(createJob);
    const result = JSON.parse(await tool.toolFn({ model: 'test-video', prompt: 'a cat' }));
    expect(result).toEqual({ jobId: 'job1', estimatedSeconds: 8 });
    expect(createJob.mock.calls[0][0]).toMatchObject({ source: 'agent', questId: 'q1', user: { id: 'u1' } });
    expect(statusUpdate).toHaveBeenCalledWith({ videoJobIds: ['job1'] });
  });

  it('sends image-to-video when an input image id is given', async () => {
    const createJob = vi.fn().mockResolvedValue(okJob);
    const { tool } = build(createJob);
    await tool.toolFn({ model: 'test-video', prompt: 'x', inputImageFileId: 'f1' });
    expect(createJob.mock.calls[0][0].request).toMatchObject({ mode: 'image_to_video', inputImageFileId: 'f1' });
  });

  it('returns a readable error and records no job', async () => {
    const createJob = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 402, code: 'insufficient_credits', message: 'Not enough credits' });
    const { tool, statusUpdate } = build(createJob);
    const text = await tool.toolFn({ model: 'test-video', prompt: 'x' });
    expect(text).toContain('insufficient_credits');
    expect(text).toContain('Not enough credits');
    expect(statusUpdate).not.toHaveBeenCalled();
  });

  it('derives a stable idempotency key per quest and request', async () => {
    const createJob = vi.fn().mockResolvedValue(okJob);
    const { tool } = build(createJob);
    await tool.toolFn({ model: 'test-video', prompt: 'a' });
    await tool.toolFn({ model: 'test-video', prompt: 'a' });
    await tool.toolFn({ model: 'test-video', prompt: 'b' });
    const keys = createJob.mock.calls.map(call => call[0].idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).not.toBe(keys[2]);
    expect(keys[0]).toMatch(/^agent:u1:q1:[0-9a-f]{32}$/);
  });

  it('omits the key without a quest', async () => {
    const createJob = vi.fn().mockResolvedValue(okJob);
    const { tool } = build(createJob, { questId: undefined });
    await tool.toolFn({ model: 'test-video', prompt: 'a' });
    expect(createJob.mock.calls[0][0].idempotencyKey).toBeUndefined();
  });

  it('never reserves or settles credits itself (the job engine bills)', async () => {
    const createJob = vi.fn().mockResolvedValue(okJob);
    const { tool, onStart, onFinish } = build(createJob);
    await tool.toolFn({ model: 'test-video', prompt: 'a' });
    expect(onStart).not.toHaveBeenCalled();
    expect(onFinish).not.toHaveBeenCalled();
  });

  it('exposes a plain JSON Schema whose model enum is the usable ids', () => {
    const { tool } = build(vi.fn());
    const parameters = tool.toolSchema.parameters as unknown as Record<string, unknown> & {
      properties: { model: { enum: string[] } };
    };
    expect(parameters.properties.model.enum).toEqual(['test-video']);
    expect(parameters.type).toBe('object');
    expect(parameters).not.toHaveProperty('$schema');
  });

  it('builds an inert tool instead of throwing when no config is wired', async () => {
    const tool = videoGenerationTool.implementation({ userId: 'u1' } as never, undefined);
    expect(tool.toolSchema.name).toBe('video_generation');
    expect(await tool.toolFn({ model: 'test-video', prompt: 'x' })).toContain('not available');
  });

  it('isVideoToolConfig rejects empty and malformed configs', () => {
    expect(isVideoToolConfig(undefined)).toBe(false);
    expect(isVideoToolConfig({ usableModels: [], createJob: vi.fn() })).toBe(false);
    expect(isVideoToolConfig({ usableModels: ['test-video'], createJob: vi.fn() })).toBe(true);
  });
});
