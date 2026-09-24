import { describe, it, expect, vi } from 'vitest';
import type { SetStateAction } from 'react';
import type { IChatCompletion } from '@client/app/hooks/useSubscribeChatCompletion';
import { IDLE_CHAT_COMPLETION, isChatCompletionActiveFor } from '@client/app/hooks/chatCompletionState';
import { CANCELLING_STATUS, stopChatCompletion } from './stopChatCompletion';

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
