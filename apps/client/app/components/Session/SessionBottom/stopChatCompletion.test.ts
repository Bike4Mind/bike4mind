import { describe, it, expect, vi } from 'vitest';
import type { SetStateAction } from 'react';
import type { IChatCompletion } from '@client/app/hooks/useSubscribeChatCompletion';
import {
  IDLE_CHAT_COMPLETION,
  OPTIMISTIC_GENERATING_STATUS,
  adoptSentQuest,
  isChatCompletionActiveFor,
  rollbackOptimisticGenerating,
  shouldResetOnSessionChange,
} from '@client/app/hooks/chatCompletionState';
import {
  CANCELLING_STATUS,
  DEFERRED_STOP_TIMEOUT_MS,
  DeferredStop,
  canStopNow,
  stopChatCompletion,
} from './stopChatCompletion';

const OPTIMISTIC = 'optimistic-session-stop';

// A minimal stand-in for the React state the hook drives.
const makeState = (initial: IChatCompletion) => {
  const box = { current: initial, history: [] as IChatCompletion[] };
  const setChatCompletion = (action: SetStateAction<IChatCompletion>) => {
    box.current = typeof action === 'function' ? action(box.current) : action;
    box.history.push(box.current);
  };
  return { box, setChatCompletion };
};

const running: IChatCompletion = {
  ...IDLE_CHAT_COMPLETION,
  completed: false,
  statusMessage: 'Running...',
  quest: { id: 'q1', sessionId: 'real-1', type: 'message', status: 'running' },
};

describe('stopChatCompletion', () => {
  it('shows "Cancelling..." while the request is out, then the cancelled state', async () => {
    const { box, setChatCompletion } = makeState({
      ...running,
      rapidReply: { content: 'ack', status: 'completed', modelId: 'm', mappingId: 'x' },
    });
    const ok = await stopChatCompletion({
      sessionId: 'real-1',
      setChatCompletion,
      stop: vi.fn().mockResolvedValue(undefined),
      getCachedQuestStatus: () => 'running',
    });

    expect(ok).toBe(true);
    expect(box.history[0].statusMessage).toBe(CANCELLING_STATUS);
    expect(box.current).toMatchObject({ completed: true, statusMessage: 'Generation cancelled by user' });
    expect(box.current.rapidReply).toBeUndefined();
  });

  it('on failure, reverts to the running state instead of leaving "Cancelling..."', async () => {
    const { box, setChatCompletion } = makeState(running);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const ok = await stopChatCompletion({
      sessionId: 'real-1',
      setChatCompletion,
      stop: vi.fn().mockRejectedValue(new Error('network')),
      getCachedQuestStatus: () => 'running',
    });

    expect(ok).toBe(false);
    expect(box.current).toMatchObject({ completed: false, stopped: false, statusMessage: 'Running...' });
    expect(isChatCompletionActiveFor(box.current, 'real-1')).toBe(true);
  });

  it('on failure, completes the turn when the cache shows the quest already ended', async () => {
    const { box, setChatCompletion } = makeState(running);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const getCachedQuestStatus = vi.fn().mockReturnValue('done');
    await stopChatCompletion({
      sessionId: 'real-1',
      setChatCompletion,
      stop: vi.fn().mockRejectedValue(new Error('network')),
      getCachedQuestStatus,
    });

    expect(getCachedQuestStatus).toHaveBeenCalledWith('q1');
    expect(box.current.completed).toBe(true);
    expect(isChatCompletionActiveFor(box.current, 'real-1')).toBe(false);
  });

  it("keeps the held quest's real session id when stopped during the optimistic window", async () => {
    const { box, setChatCompletion } = makeState(running);
    await stopChatCompletion({
      sessionId: OPTIMISTIC,
      setChatCompletion,
      stop: vi.fn().mockResolvedValue(undefined),
      getCachedQuestStatus: () => undefined,
    });

    expect(box.history[0].quest?.sessionId).toBe('real-1');
  });

  it('stamps the current session onto a placeholder that has no quest yet', async () => {
    const placeholder: IChatCompletion = { ...IDLE_CHAT_COMPLETION, completed: false, statusMessage: 'Generating' };
    const { box, setChatCompletion } = makeState(placeholder);
    await stopChatCompletion({
      sessionId: 'real-2',
      setChatCompletion,
      stop: vi.fn().mockResolvedValue(undefined),
      getCachedQuestStatus: () => undefined,
    });

    expect(box.history[0].quest?.sessionId).toBe('real-2');
  });
});

describe('DeferredStop', () => {
  const placeholder: IChatCompletion = {
    ...IDLE_CHAT_COMPLETION,
    completed: false,
    statusMessage: OPTIMISTIC_GENERATING_STATUS,
  };
  const sentQuest = { id: 'q1', sessionId: 'real-1', type: 'message' as const, status: 'running' as const };

  it('can stop a turn whose quest is known on a real session', () => {
    expect(canStopNow('real-1', running)).toBe(true);
    expect(canStopNow(OPTIMISTIC, running)).toBe(false);
    expect(canStopNow(null, running)).toBe(false);
    expect(canStopNow('real-1', placeholder)).toBe(false);
  });

  it('holds a Stop pressed in the optimistic window, then sends it to the real session once the quest arrives', async () => {
    const { box, setChatCompletion } = makeState(placeholder);
    const stop = vi.fn().mockResolvedValue(undefined);
    const deferred = new DeferredStop(setChatCompletion);

    deferred.request(box.current);
    expect(box.current).toMatchObject({ completed: false, stopped: true, statusMessage: CANCELLING_STATUS });
    expect(box.current.quest).toBeUndefined();
    // Nothing stamped, so the optimistic -> real id switch keeps the state.
    expect(shouldResetOnSessionChange(OPTIMISTIC, 'real-1', box.current)).toBe(false);
    expect(deferred.resolve(box.current)).toBeNull();

    setChatCompletion(prev => adoptSentQuest(prev, sentQuest));
    const held = deferred.resolve(box.current);
    expect(held).toEqual({ sessionId: 'real-1', beforeStop: placeholder });
    expect(deferred.isPending).toBe(false);

    const ok = await stopChatCompletion({
      sessionId: held!.sessionId,
      setChatCompletion,
      stop,
      getCachedQuestStatus: () => 'running',
      restoreTo: held!.beforeStop,
    });
    expect(ok).toBe(true);
    expect(stop).toHaveBeenCalledExactlyOnceWith('real-1');
    expect(box.current).toMatchObject({ completed: true, statusMessage: 'Generation cancelled by user' });
  });

  it('resolves from the first stream frame too, using the quest session id', () => {
    const { box, setChatCompletion } = makeState(placeholder);
    const deferred = new DeferredStop(setChatCompletion);
    deferred.request(box.current);

    setChatCompletion(prev => ({ ...prev, quest: sentQuest, statusMessage: 'Spinning up...' }));
    expect(deferred.resolve(box.current)?.sessionId).toBe('real-1');
  });

  it('restores the pre-stop state, not "Cancelling...", when the held Stop then fails', async () => {
    const { box, setChatCompletion } = makeState(placeholder);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const deferred = new DeferredStop(setChatCompletion);
    deferred.request(box.current);
    setChatCompletion(prev => adoptSentQuest(prev, sentQuest));
    const held = deferred.resolve(box.current)!;

    await stopChatCompletion({
      sessionId: held.sessionId,
      setChatCompletion,
      stop: vi.fn().mockRejectedValue(new Error('network')),
      getCachedQuestStatus: () => 'running',
      restoreTo: held.beforeStop,
    });
    expect(box.current).toMatchObject({
      completed: false,
      stopped: false,
      statusMessage: OPTIMISTIC_GENERATING_STATUS,
    });
    expect(box.current.quest?.id).toBe('q1');
  });

  it('ends quietly when the reply finishes before the quest id is known', () => {
    const { box, setChatCompletion } = makeState(placeholder);
    const deferred = new DeferredStop(setChatCompletion);
    deferred.request(box.current);

    setChatCompletion(prev => ({
      ...prev,
      completed: true,
      statusMessage: undefined,
      quest: { ...sentQuest, status: 'done' },
    }));
    expect(deferred.resolve(box.current)).toBeNull();
    expect(deferred.isPending).toBe(false);
    expect(box.current).toMatchObject({ completed: true, stopped: false, statusMessage: undefined });
  });

  it('drops the held Stop when the view resets to another session', () => {
    const { box, setChatCompletion } = makeState(placeholder);
    const deferred = new DeferredStop(setChatCompletion);
    deferred.request(box.current);

    setChatCompletion(IDLE_CHAT_COMPLETION);
    expect(deferred.resolve(box.current)).toBeNull();
    expect(deferred.isPending).toBe(false);
    expect(box.current).toEqual(IDLE_CHAT_COMPLETION);
  });

  it('a failed send cancels it and the rollback still clears Stop', () => {
    const { box, setChatCompletion } = makeState(placeholder);
    const deferred = new DeferredStop(setChatCompletion);
    deferred.request(box.current);

    deferred.cancel();
    setChatCompletion(rollbackOptimisticGenerating);
    expect(deferred.isPending).toBe(false);
    expect(box.current).toMatchObject({ completed: true, stopped: false, statusMessage: undefined });
    expect(isChatCompletionActiveFor(box.current, 'real-1')).toBe(false);
    setChatCompletion(prev => adoptSentQuest(prev, sentQuest));
    expect(deferred.resolve(box.current)).toBeNull();
  });

  it('gives up and restores the state when no quest arrives before the timeout', () => {
    vi.useFakeTimers();
    try {
      const { box, setChatCompletion } = makeState(placeholder);
      const deferred = new DeferredStop(setChatCompletion);
      deferred.request(box.current);

      vi.advanceTimersByTime(DEFERRED_STOP_TIMEOUT_MS);
      expect(deferred.isPending).toBe(false);
      expect(box.current).toMatchObject({
        completed: false,
        stopped: false,
        statusMessage: OPTIMISTIC_GENERATING_STATUS,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a second press while one is held', () => {
    const { box, setChatCompletion } = makeState(placeholder);
    const deferred = new DeferredStop(setChatCompletion);
    deferred.request(box.current);
    deferred.request(box.current);
    setChatCompletion(prev => adoptSentQuest(prev, sentQuest));
    expect(deferred.resolve(box.current)?.beforeStop).toBe(placeholder);
  });
});
