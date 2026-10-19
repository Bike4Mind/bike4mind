import { describe, it, expect, vi } from 'vitest';
import type { Logger } from '@bike4mind/observability';
import { attachGenerationJobsToRunQuest, publishRunGenerationJobs } from './agentExecutor.generationJobs';

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

describe('publishRunGenerationJobs', () => {
  const EXECUTION_ID = 'exec-1';

  it('tells the client about the new jobs once they are on the run quest', async () => {
    const calls: string[] = [];
    const quests = { addGenerationJobs: vi.fn(async () => void calls.push('attach')) };
    const sendWs = vi.fn(async () => void calls.push('send'));
    await publishRunGenerationJobs({
      jobs: [music],
      questId: QUEST_ID,
      executionId: EXECUTION_ID,
      questRepository: quests,
      sendWs,
      logger: makeLogger(),
    });
    expect(sendWs).toHaveBeenCalledWith('progress', {
      executionId: EXECUTION_ID,
      questId: QUEST_ID,
      generationJobs: [music],
    });
    expect(calls).toEqual(['attach', 'send']);
  });

  it('still tells the client when the quest write fails, since the job exists', async () => {
    const quests = { addGenerationJobs: vi.fn(async () => Promise.reject(new Error('db down'))) };
    const sendWs = vi.fn(async () => undefined);
    await publishRunGenerationJobs({
      jobs: [music],
      questId: QUEST_ID,
      executionId: EXECUTION_ID,
      questRepository: quests,
      sendWs,
      logger: makeLogger(),
    });
    expect(sendWs).toHaveBeenCalledWith('progress', expect.objectContaining({ generationJobs: [music] }));
  });

  it('warns instead of failing the tool call when the send throws', async () => {
    const sendWs = vi.fn(async () => Promise.reject(new Error('gone')));
    const logger = makeLogger();
    await expect(
      publishRunGenerationJobs({
        jobs: [music],
        questId: QUEST_ID,
        executionId: EXECUTION_ID,
        questRepository: makeQuests(),
        sendWs,
        logger,
      })
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('send'),
      expect.objectContaining({ questId: QUEST_ID })
    );
  });

  it('sends nothing without a run quest to put the cards on', async () => {
    const sendWs = vi.fn(async () => undefined);
    await publishRunGenerationJobs({
      jobs: [music],
      questId: undefined,
      executionId: EXECUTION_ID,
      questRepository: makeQuests(),
      sendWs,
      logger: makeLogger(),
    });
    expect(sendWs).not.toHaveBeenCalled();
  });

  it('sends nothing for a status update without jobs', async () => {
    const quests = makeQuests();
    const sendWs = vi.fn(async () => undefined);
    for (const jobs of [undefined, []]) {
      await publishRunGenerationJobs({
        jobs,
        questId: QUEST_ID,
        executionId: EXECUTION_ID,
        questRepository: quests,
        sendWs,
        logger: makeLogger(),
      });
    }
    expect(sendWs).not.toHaveBeenCalled();
    expect(quests.addGenerationJobs).not.toHaveBeenCalled();
  });
});
