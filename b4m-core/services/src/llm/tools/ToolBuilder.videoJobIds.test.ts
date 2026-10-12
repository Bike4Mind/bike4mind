import { describe, it, expect, vi } from 'vitest';
import type { ICompletionBackend } from '@bike4mind/llm-adapters';
import { ToolBuilder, type ToolBuilderConfig } from './ToolBuilder';
import type { VideoToolConfig } from './implementation/videoGeneration';

// Drives the REAL buildSharedTools wiring: the video tool's statusUpdate lands in ToolBuilder's
// onStatusUpdate, which must write the job id to the stored quest before the tool returns.
// Before this, only the ~10s streaming heartbeat persisted it, so a chat process dying in that
// window left a billed job with no card in the chat.

type ToolFn = (args: unknown) => Promise<string>;

const okJob = (id: string) => ({ ok: true as const, created: true, job: { id } });

const buildVideoTool = (createJob: VideoToolConfig['createJob'], addVideoJobIds = vi.fn()) => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), updateMetadata: vi.fn() };
  const sendStatusUpdate = vi.fn().mockResolvedValue(undefined);
  const saveQuest = vi.fn().mockResolvedValue(null);
  const deps = {
    user: { id: 'u1', currentCredits: 1_000_000 },
    logger,
    db: { quests: { addVideoJobIds } },
    toolCreditsMap: new Map(),
    toolCreditModels: new Set(),
    sendStatusUpdate,
    extraContextMessages: [],
  } as unknown as ToolBuilderConfig;
  const quest = { id: 'q1', sessionId: 's1' } as { id: string; sessionId: string; videoJobIds?: string[] };
  const config: VideoToolConfig = { usableModels: ['test-video'], createJob };

  const tools = new ToolBuilder(deps).buildTools({
    enabledTools: ['video_generation'],
    quest,
    saveQuest,
    llm: { currentModel: 'm', complete: vi.fn() } as unknown as ICompletionBackend,
    config: { video_generation: config },
    organization: null,
  } as never);
  const tool = tools?.find(t => t.toolSchema.name === 'video_generation');
  if (!tool) throw new Error('video_generation was not built');
  return { toolFn: tool.toolFn as ToolFn, quest, addVideoJobIds, sendStatusUpdate, saveQuest, logger };
};

describe('ToolBuilder: video_generation persists the chat card job id', () => {
  it('writes the job id to the stored quest before the tool returns', async () => {
    const addVideoJobIds = vi.fn().mockResolvedValue(undefined);
    const { toolFn, quest, sendStatusUpdate, saveQuest } = buildVideoTool(
      vi.fn().mockResolvedValue(okJob('job-1')),
      addVideoJobIds
    );

    const result = JSON.parse(await toolFn({ model: 'test-video', prompt: 'a cat' }));

    expect(result.jobId).toBe('job-1');
    expect(addVideoJobIds).toHaveBeenCalledWith('q1', ['job-1']);
    // Durable on its own: neither the whole-quest save nor the throttled client push is relied on.
    expect(saveQuest).not.toHaveBeenCalled();
    expect(addVideoJobIds.mock.invocationCallOrder[0]).toBeLessThan(sendStatusUpdate.mock.invocationCallOrder[0]);
    // A later whole-quest save writes the in-memory copy, so it must carry the id too.
    expect(quest.videoJobIds).toEqual(['job-1']);
  });

  it('does not duplicate the id when a replayed call returns the existing job', async () => {
    const addVideoJobIds = vi.fn().mockResolvedValue(undefined);
    const createJob = vi
      .fn()
      .mockResolvedValueOnce(okJob('job-1'))
      .mockResolvedValueOnce({ ...okJob('job-1'), created: false });
    const { toolFn, quest } = buildVideoTool(createJob, addVideoJobIds);

    await toolFn({ model: 'test-video', prompt: 'a cat' });
    await toolFn({ model: 'test-video', prompt: 'a cat' });

    expect(quest.videoJobIds).toEqual(['job-1']);
    // The stored side dedups by $addToSet (see QuestModel.videoJobIds.test.ts).
    expect(addVideoJobIds.mock.calls).toEqual([
      ['q1', ['job-1']],
      ['q1', ['job-1']],
    ]);
  });

  it('still returns the job when the quest write fails', async () => {
    const addVideoJobIds = vi.fn().mockRejectedValue(new Error('mongo down'));
    const { toolFn, quest, logger } = buildVideoTool(vi.fn().mockResolvedValue(okJob('job-1')), addVideoJobIds);

    const result = JSON.parse(await toolFn({ model: 'test-video', prompt: 'a cat' }));

    expect(result.jobId).toBe('job-1');
    expect(quest.videoJobIds).toEqual(['job-1']);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('job-1'), expect.any(Error));
  });
});
