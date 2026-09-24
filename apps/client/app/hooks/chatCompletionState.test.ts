import { describe, it, expect } from 'vitest';
import {
  IDLE_CHAT_COMPLETION,
  OPTIMISTIC_GENERATING_STATUS,
  TerminalQuestTracker,
  BlankRapidReplyTracker,
  adoptSentQuest,
  isChatCompletionActiveFor,
  isTerminalQuestStatus,
  resolveStopFailure,
  rollbackOptimisticGenerating,
  shouldAcceptRapidReply,
  shouldAcceptStreamFrame,
  shouldResetOnSessionChange,
} from './chatCompletionState';
import type { IChatCompletion } from './useSubscribeChatCompletion';

const OPTIMISTIC = 'optimistic-session-abc';
const CANCELLING = 'Cancelling generation...';

const quest = (id: string, sessionId: string, status: 'running' | 'done' | 'stopped' = 'running') => ({
  id,
  sessionId,
  type: 'message' as const,
  status,
});

const awaitingOwnSend: IChatCompletion = { ...IDLE_CHAT_COMPLETION, completed: false, statusMessage: 'Generating' };

describe('isTerminalQuestStatus', () => {
  it('treats every non-running status as terminal', () => {
    expect(isTerminalQuestStatus('done')).toBe(true);
    expect(isTerminalQuestStatus('stopped')).toBe(true);
    expect(isTerminalQuestStatus('running')).toBe(false);
    expect(isTerminalQuestStatus(undefined)).toBe(false);
  });
});

describe('shouldAcceptStreamFrame', () => {
  const frame = (frameSessionId: string, frameQuestId: string) => ({ frameSessionId, frameQuestId });

  it('accepts frames for the viewed session', () => {
    expect(
      shouldAcceptStreamFrame({
        ...frame('s1', 'q1'),
        sessionId: 's1',
        pendingSessionId: null,
        current: IDLE_CHAT_COMPLETION,
      })
    ).toBe(true);
  });

  it('drops another real session while viewing a real session', () => {
    expect(
      shouldAcceptStreamFrame({
        ...frame('s2', 'q2'),
        sessionId: 's1',
        pendingSessionId: 's2',
        current: awaitingOwnSend,
      })
    ).toBe(false);
  });

  it("adopts the first frame for the tab's own send while the session id is optimistic", () => {
    expect(
      shouldAcceptStreamFrame({
        ...frame('real', 'q1'),
        sessionId: OPTIMISTIC,
        pendingSessionId: null,
        current: awaitingOwnSend,
      })
    ).toBe(true);
  });

  it('does not adopt a foreign stream on a new notebook when nothing was sent from this tab', () => {
    for (const sessionId of [null, OPTIMISTIC]) {
      expect(
        shouldAcceptStreamFrame({
          ...frame('other', 'q9'),
          sessionId,
          pendingSessionId: null,
          current: IDLE_CHAT_COMPLETION,
        })
      ).toBe(false);
    }
  });

  it('once a quest is held, only accepts that quest while the session is still being minted', () => {
    const current = { ...awaitingOwnSend, quest: quest('q1', 'real') };
    expect(
      shouldAcceptStreamFrame({ ...frame('real', 'q1'), sessionId: OPTIMISTIC, pendingSessionId: null, current })
    ).toBe(true);
    expect(
      shouldAcceptStreamFrame({ ...frame('other', 'q9'), sessionId: OPTIMISTIC, pendingSessionId: null, current })
    ).toBe(false);
  });

  it('accepts the pending session while the id is still null', () => {
    expect(
      shouldAcceptStreamFrame({
        ...frame('real', 'q2'),
        sessionId: null,
        pendingSessionId: 'real',
        current: IDLE_CHAT_COMPLETION,
      })
    ).toBe(true);
  });
});

describe('shouldAcceptStreamFrame - own first send after the provider remounts', () => {
  const minting = (frameSessionId: string, mintedSessionId: string | null, current = IDLE_CHAT_COMPLETION) =>
    shouldAcceptStreamFrame({
      frameSessionId,
      frameQuestId: 'q1',
      sessionId: OPTIMISTIC,
      pendingSessionId: null,
      current,
      mintingOwnSession: true,
      mintedSessionId,
    });

  it("adopts the tab's own first frame on the optimistic id even though the remounted state reads idle", () => {
    expect(minting('real', 'real')).toBe(true);
  });

  it('accepts nothing before the real session id is recorded, even with a send awaiting', () => {
    expect(minting('real', null)).toBe(false);
    expect(minting('other', null, awaitingOwnSend)).toBe(false);
  });

  it('refuses any other session once the real id is recorded', () => {
    expect(minting('other', 'real')).toBe(false);
    expect(minting('other', 'real', awaitingOwnSend)).toBe(false);
  });

  it('still refuses a second quest once the first is held', () => {
    expect(
      shouldAcceptStreamFrame({
        frameSessionId: 'other',
        frameQuestId: 'q9',
        sessionId: OPTIMISTIC,
        pendingSessionId: null,
        current: { ...IDLE_CHAT_COMPLETION, completed: false, quest: quest('q1', 'real') },
        mintingOwnSession: true,
      })
    ).toBe(false);
  });
});

describe('BlankRapidReplyTracker', () => {
  it('lets each in-flight request claim exactly one id-less ack', () => {
    const tracker = new BlankRapidReplyTracker();
    expect(tracker.claim()).toBe(false);
    const release = tracker.begin();
    expect(tracker.claim()).toBe(true);
    expect(tracker.claim()).toBe(false);
    release();
    expect(tracker.claim()).toBe(false);
  });

  it('drops a request whose ack never came once it settles', () => {
    const tracker = new BlankRapidReplyTracker();
    const release = tracker.begin();
    release();
    release();
    expect(tracker.claim()).toBe(false);
  });
});

describe('shouldAcceptRapidReply', () => {
  const base = { sessionId: 's1', pendingSessionId: null, current: IDLE_CHAT_COMPLETION };

  it('applies the stream-frame rule when the ack names a session', () => {
    const claimBlank = () => true;
    expect(shouldAcceptRapidReply({ ...base, frameSessionId: 's1', frameQuestId: undefined, claimBlank })).toBe(true);
    expect(shouldAcceptRapidReply({ ...base, frameSessionId: 's2', frameQuestId: undefined, claimBlank })).toBe(false);
  });

  it('only claims a blank request for an ack with neither id', () => {
    let claimed = 0;
    const claimBlank = () => {
      claimed++;
      return true;
    };
    expect(shouldAcceptRapidReply({ ...base, frameSessionId: 's2', frameQuestId: undefined, claimBlank })).toBe(false);
    expect(claimed).toBe(0);
    expect(shouldAcceptRapidReply({ ...base, frameSessionId: undefined, frameQuestId: undefined, claimBlank })).toBe(
      true
    );
    expect(claimed).toBe(1);
  });
});

describe('rollbackOptimisticGenerating', () => {
  it('clears the send-time placeholder', () => {
    const placeholder = { ...IDLE_CHAT_COMPLETION, completed: false, statusMessage: OPTIMISTIC_GENERATING_STATUS };
    expect(rollbackOptimisticGenerating(placeholder)).toMatchObject({ completed: true, statusMessage: undefined });
  });

  it('leaves a real in-flight stream alone', () => {
    const streaming = { ...IDLE_CHAT_COMPLETION, completed: false, statusMessage: 'Running...' };
    expect(rollbackOptimisticGenerating(streaming)).toBe(streaming);
  });

  it('uses a sentinel no ASCII server status can equal', () => {
    expect(OPTIMISTIC_GENERATING_STATUS).toBe('Generating\u2026');
    expect(OPTIMISTIC_GENERATING_STATUS).not.toBe('Generating...');
  });
});

describe('shouldResetOnSessionChange', () => {
  it('resets on a real -> real switch when the held quest belongs to the old session', () => {
    expect(shouldResetOnSessionChange('s1', 's2', { quest: quest('q1', 's1') })).toBe(true);
    expect(shouldResetOnSessionChange('s1', 's2', { quest: undefined })).toBe(true);
  });

  it('resets when leaving a session for a new notebook', () => {
    expect(shouldResetOnSessionChange('s1', null, { quest: quest('q1', 's1') })).toBe(true);
    expect(shouldResetOnSessionChange('s1', null, { quest: undefined })).toBe(true);
  });

  it('keeps the state through the new-notebook flow (null -> optimistic -> real)', () => {
    expect(shouldResetOnSessionChange(null, OPTIMISTIC, { quest: undefined })).toBe(false);
    expect(shouldResetOnSessionChange(OPTIMISTIC, 'real', { quest: undefined })).toBe(false);
    expect(shouldResetOnSessionChange(OPTIMISTIC, 'real', { quest: quest('q1', 'real') })).toBe(false);
  });

  it('resets when the optimistic id resolves to a session other than the held quest', () => {
    expect(shouldResetOnSessionChange(OPTIMISTIC, 'real', { quest: quest('q1', 'other') })).toBe(true);
  });

  it('keeps a quest that belongs to the session being switched to', () => {
    expect(shouldResetOnSessionChange('s1', 's2', { quest: quest('q2', 's2') })).toBe(false);
  });
});

describe('isChatCompletionActiveFor', () => {
  const running = { ...IDLE_CHAT_COMPLETION, completed: false, quest: quest('q1', 's1') };

  it('shows Stop for the session the quest belongs to', () => {
    expect(isChatCompletionActiveFor(running, 's1')).toBe(true);
  });

  it("hides Stop for another session's quest", () => {
    expect(isChatCompletionActiveFor(running, 's2')).toBe(false);
    expect(isChatCompletionActiveFor(running, null)).toBe(false);
  });

  it("shows Stop for the tab's own send before its first frame, and across the optimistic id", () => {
    expect(isChatCompletionActiveFor(awaitingOwnSend, null)).toBe(true);
    expect(isChatCompletionActiveFor(running, OPTIMISTIC)).toBe(true);
  });

  it('hides Stop once complete', () => {
    expect(isChatCompletionActiveFor({ ...running, completed: true }, 's1')).toBe(false);
  });
});

describe('TerminalQuestTracker', () => {
  it("ignores a 'running' frame that lands after the quest ended", () => {
    const tracker = new TerminalQuestTracker();
    tracker.markTerminal('q1', '2026-01-01T00:00:05Z');
    expect(tracker.isStaleFrame('q1', 'running', '2026-01-01T00:00:05Z')).toBe(true);
    expect(tracker.isStaleFrame('q1', 'running', undefined)).toBe(true);
  });

  it('never treats a terminal frame (e.g. a late stopped) as stale', () => {
    const tracker = new TerminalQuestTracker();
    tracker.markTerminal('q1', undefined);
    expect(tracker.isStaleFrame('q1', 'stopped', undefined)).toBe(false);
    expect(tracker.isStaleFrame('q1', 'done', undefined)).toBe(false);
  });

  it('lets a restarted quest through when its updatedAt is strictly newer', () => {
    const tracker = new TerminalQuestTracker();
    tracker.markTerminal('q1', '2026-01-01T00:00:05Z');
    expect(tracker.isStaleFrame('q1', 'running', '2026-01-01T00:01:00Z')).toBe(false);
    // Unmarked: later chunks of the new run pass too.
    expect(tracker.isStaleFrame('q1', 'running', undefined)).toBe(false);
  });

  it('lets a deliberately re-run quest through after forget()', () => {
    const tracker = new TerminalQuestTracker();
    tracker.markTerminal('q1', undefined);
    tracker.forget('q1');
    expect(tracker.isStaleFrame('q1', 'running', undefined)).toBe(false);
  });

  it('stays bounded, evicting the oldest quest', () => {
    const tracker = new TerminalQuestTracker(2);
    tracker.markTerminal('q1');
    tracker.markTerminal('q2');
    tracker.markTerminal('q3');
    expect(tracker.isStaleFrame('q1', 'running')).toBe(false);
    expect(tracker.isStaleFrame('q3', 'running')).toBe(true);
  });
});

describe('resolveStopFailure', () => {
  const beforeStop: IChatCompletion = {
    ...IDLE_CHAT_COMPLETION,
    completed: false,
    statusMessage: 'Running...',
    quest: quest('q1', 's1'),
  };
  const cancelling: IChatCompletion = { ...beforeStop, stopped: true, statusMessage: CANCELLING };

  it('reverts to the pre-stop state while the quest may still be running', () => {
    expect(resolveStopFailure(cancelling, beforeStop, 'running', CANCELLING)).toMatchObject({
      completed: false,
      stopped: false,
      statusMessage: 'Running...',
    });
  });

  it('marks the turn complete when the cache says the quest already ended', () => {
    const next = resolveStopFailure(cancelling, beforeStop, 'done', CANCELLING);
    expect(next.completed).toBe(true);
    expect(next.statusMessage).toBeUndefined();
    expect(isChatCompletionActiveFor(next, 's1')).toBe(false);
  });

  it('never leaves "Cancelling..." behind', () => {
    for (const cached of ['running', 'done', undefined]) {
      expect(resolveStopFailure(cancelling, beforeStop, cached, CANCELLING).statusMessage).not.toBe(CANCELLING);
    }
  });

  it('restores a placeholder with no quest id instead of the stop handler stub', () => {
    const placeholder: IChatCompletion = { ...IDLE_CHAT_COMPLETION, completed: false, statusMessage: 'Generating' };
    const stub: IChatCompletion = {
      ...placeholder,
      stopped: true,
      statusMessage: CANCELLING,
      quest: { sessionId: 's1' } as IChatCompletion['quest'],
    };
    expect(resolveStopFailure(stub, placeholder, undefined, CANCELLING)).toMatchObject({
      quest: undefined,
      statusMessage: 'Generating',
    });
  });

  it('leaves a state a frame already moved on untouched apart from clearing stopped', () => {
    const done: IChatCompletion = { ...beforeStop, completed: true, stopped: true, statusMessage: null };
    expect(resolveStopFailure(done, beforeStop, 'running', CANCELLING)).toEqual({ ...done, stopped: false });
  });
});

describe('adoptSentQuest', () => {
  it('pins the sent quest onto a placeholder still awaiting its first frame', () => {
    expect(adoptSentQuest(awaitingOwnSend, quest('q1', 's1')).quest).toMatchObject({
      id: 'q1',
      sessionId: 's1',
      status: 'running',
    });
  });

  it('does not overwrite a quest a frame already delivered, or revive an ended turn', () => {
    const streaming = { ...awaitingOwnSend, quest: quest('q1', 's1') };
    expect(adoptSentQuest(streaming, quest('q2', 's1'))).toBe(streaming);
    expect(adoptSentQuest(IDLE_CHAT_COMPLETION, quest('q1', 's1'))).toBe(IDLE_CHAT_COMPLETION);
  });
});
