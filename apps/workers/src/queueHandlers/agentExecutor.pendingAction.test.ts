import { describe, it, expect, vi } from 'vitest';
import type { Logger } from '@bike4mind/observability';
import { attachPendingActionToRunQuest } from './agentExecutor.pendingAction';

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
