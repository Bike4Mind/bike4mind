import { describe, it, expect, vi } from 'vitest';
import type { Logger } from '@bike4mind/observability';
import { attachGenerationJobsToRunQuest } from './agentExecutor.generationJobs';

const QUEST_ID = 'quest-1';
const makeLogger = () => ({ warn: vi.fn() }) as unknown as Logger & { warn: ReturnType<typeof vi.fn> };
const makeQuests = () => ({ addGenerationJobs: vi.fn(async () => undefined) });
const music = { id: 'job-1', kind: 'music' } as const;

describe('attachGenerationJobsToRunQuest', () => {
  it('writes the new jobs onto the run quest', async () => {
    const quests = makeQuests();
    await attachGenerationJobsToRunQuest([music], QUEST_ID, quests, makeLogger());
    expect(quests.addGenerationJobs).toHaveBeenCalledWith(QUEST_ID, [music]);
  });

  it('writes nothing without jobs or without a run quest', async () => {
    const quests = makeQuests();
    await attachGenerationJobsToRunQuest(undefined, QUEST_ID, quests, makeLogger());
    await attachGenerationJobsToRunQuest([], QUEST_ID, quests, makeLogger());
    await attachGenerationJobsToRunQuest([music], undefined, quests, makeLogger());
    expect(quests.addGenerationJobs).not.toHaveBeenCalled();
  });

  it('warns instead of failing the tool call when the write fails', async () => {
    const quests = { addGenerationJobs: vi.fn(async () => Promise.reject(new Error('db down'))) };
    const logger = makeLogger();
    await expect(attachGenerationJobsToRunQuest([music], QUEST_ID, quests, logger)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('attach'),
      expect.objectContaining({ questId: QUEST_ID })
    );
  });
});
