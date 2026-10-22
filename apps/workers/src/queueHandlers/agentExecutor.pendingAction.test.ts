import { describe, it, expect, vi } from 'vitest';
import type { Logger } from '@bike4mind/observability';
import { attachPendingActionToRunQuest, publishRunPendingAction } from './agentExecutor.pendingAction';

const QUEST_ID = 'quest-1';
const action = { tool: 'create_issue', params: { owner: 'o', repo: 'r', title: 't' }, ts: 123 };
const makeLogger = () => ({ warn: vi.fn() }) as unknown as Logger & { warn: ReturnType<typeof vi.fn> };
const makeQuests = () => ({ setPendingAction: vi.fn(async () => undefined) });

describe('attachPendingActionToRunQuest', () => {
  it('writes the pending action onto the run quest', async () => {
    const quests = makeQuests();
    await attachPendingActionToRunQuest(action, QUEST_ID, quests, makeLogger());
    expect(quests.setPendingAction).toHaveBeenCalledWith(QUEST_ID, action);
  });

  it('warns and writes nothing without a run quest', async () => {
    const quests = makeQuests();
    const logger = makeLogger();
    await attachPendingActionToRunQuest(action, undefined, quests, logger);
    expect(quests.setPendingAction).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('no Confirm card'), { tool: action.tool });
  });

  it('propagates a write failure so the tool wrapper can log it', async () => {
    const quests = { setPendingAction: vi.fn(async () => Promise.reject(new Error('db down'))) };
    await expect(attachPendingActionToRunQuest(action, QUEST_ID, quests, makeLogger())).rejects.toThrow('db down');
  });
});

describe('publishRunPendingAction', () => {
  const EXECUTION_ID = 'exec-1';

  it('tells the client about the action once it is on the run quest', async () => {
    const calls: string[] = [];
    const quests = { setPendingAction: vi.fn(async () => void calls.push('write')) };
    const sendWs = vi.fn(async () => void calls.push('send'));
    await publishRunPendingAction({
      executionId: EXECUTION_ID,
      questId: QUEST_ID,
      action,
      questRepository: quests,
      sendWs,
      logger: makeLogger(),
    });
    expect(sendWs).toHaveBeenCalledWith('progress', {
      executionId: EXECUTION_ID,
      questId: QUEST_ID,
      pendingAction: action,
    });
    expect(calls).toEqual(['write', 'send']);
  });

  it('sends no frame without a run quest', async () => {
    const sendWs = vi.fn(async () => undefined);
    await publishRunPendingAction({
      executionId: EXECUTION_ID,
      questId: undefined,
      action,
      questRepository: makeQuests(),
      sendWs,
      logger: makeLogger(),
    });
    expect(sendWs).not.toHaveBeenCalled();
  });

  it('warns instead of throwing when the send fails', async () => {
    const logger = makeLogger();
    await expect(
      publishRunPendingAction({
        executionId: EXECUTION_ID,
        questId: QUEST_ID,
        action,
        questRepository: makeQuests(),
        sendWs: vi.fn(async () => Promise.reject(new Error('ws down'))),
        logger,
      })
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('send'),
      expect.objectContaining({ questId: QUEST_ID })
    );
  });

  it('rejects, and sends nothing, when the write fails', async () => {
    const sendWs = vi.fn(async () => undefined);
    await expect(
      publishRunPendingAction({
        executionId: EXECUTION_ID,
        questId: QUEST_ID,
        action,
        questRepository: { setPendingAction: vi.fn(async () => Promise.reject(new Error('db down'))) },
        sendWs,
        logger: makeLogger(),
      })
    ).rejects.toThrow('db down');
    expect(sendWs).not.toHaveBeenCalled();
  });
});
