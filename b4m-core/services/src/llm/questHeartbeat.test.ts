import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startQuestHeartbeat, QUEST_HEARTBEAT_INTERVAL_MS } from './questHeartbeat';

function makeDb() {
  return {
    quests: {
      update: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue(undefined),
    },
  };
}

function makeLogger() {
  return { warn: vi.fn(), error: vi.fn() };
}

describe('startQuestHeartbeat', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('persists status=running to the DB immediately', async () => {
    const db = makeDb();
    const quest = { id: 'q1', status: 'running' };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural test double for the repo
    const stop = await startQuestHeartbeat(db as any, quest, makeLogger(), 'test');
    expect(db.quests.update).toHaveBeenCalledWith({ id: 'q1', status: 'running' });
    stop();
  });

  it('issues a conditional (filtered) heartbeat write each interval while running', async () => {
    const db = makeDb();
    const quest = { id: 'q1', status: 'running' };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural test double for the repo
    const stop = await startQuestHeartbeat(db as any, quest, makeLogger(), 'test');
    await vi.advanceTimersByTimeAsync(QUEST_HEARTBEAT_INTERVAL_MS * 2);
    expect(db.quests.updateMany).toHaveBeenCalledTimes(2);
    expect(db.quests.updateMany).toHaveBeenCalledWith({ _id: 'q1', status: 'running' }, { status: 'running' });
    stop();
  });

  it('stops writing after the disposer is called', async () => {
    const db = makeDb();
    const quest = { id: 'q1', status: 'running' };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural test double for the repo
    const stop = await startQuestHeartbeat(db as any, quest, makeLogger(), 'test');
    stop();
    await vi.advanceTimersByTimeAsync(QUEST_HEARTBEAT_INTERVAL_MS * 3);
    expect(db.quests.updateMany).not.toHaveBeenCalled();
  });

  it('skips the write once the quest is no longer running (terminal write won the race)', async () => {
    const db = makeDb();
    const quest = { id: 'q1', status: 'running' };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural test double for the repo
    const stop = await startQuestHeartbeat(db as any, quest, makeLogger(), 'test');
    quest.status = 'done';
    await vi.advanceTimersByTimeAsync(QUEST_HEARTBEAT_INTERVAL_MS * 2);
    expect(db.quests.updateMany).not.toHaveBeenCalled();
    stop();
  });

  it('escalates warn -> error after sustained consecutive failures', async () => {
    const db = makeDb();
    db.quests.updateMany.mockRejectedValue(new Error('db down'));
    const logger = makeLogger();
    const quest = { id: 'q1', status: 'running' };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural test double for the repo
    const stop = await startQuestHeartbeat(db as any, quest, logger, 'test');
    await vi.advanceTimersByTimeAsync(QUEST_HEARTBEAT_INTERVAL_MS * 3);
    expect(logger.warn).toHaveBeenCalledTimes(2); // failures 1 and 2 warn
    expect(logger.error).toHaveBeenCalledTimes(1); // 3rd consecutive failure escalates
    stop();
  });

  it('resets the failure counter after a successful write (no premature escalation)', async () => {
    const db = makeDb();
    db.quests.updateMany
      .mockRejectedValueOnce(new Error('blip'))
      .mockRejectedValueOnce(new Error('blip'))
      .mockResolvedValueOnce(undefined) // success resets the counter
      .mockRejectedValue(new Error('blip'));
    const logger = makeLogger();
    const quest = { id: 'q1', status: 'running' };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural test double for the repo
    const stop = await startQuestHeartbeat(db as any, quest, logger, 'test');
    await vi.advanceTimersByTimeAsync(QUEST_HEARTBEAT_INTERVAL_MS * 4);
    // fail, fail, success (reset), fail -> never 3 consecutive, so no escalation
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(3);
    stop();
  });
});
