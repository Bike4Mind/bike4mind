import { describe, expect, it, vi } from 'vitest';
import { TurnReplyDiffer, createTurnFrameTee, type QuestSnapshot } from './turnFrameStream';

const QUEST = 'quest-1';
const frame = (replies: string[], extra: Partial<QuestSnapshot> = {}): QuestSnapshot => ({
  id: QUEST,
  status: 'running',
  replies,
  ...extra,
});

describe('TurnReplyDiffer', () => {
  it('sends the appended suffix of a growing slot as a delta', () => {
    const differ = new TurnReplyDiffer(QUEST);
    expect(differ.observe(frame(['Hel']))).toEqual([{ type: 'delta', quest_id: QUEST, slot: 0, text: 'Hel' }]);
    expect(differ.observe(frame(['Hello']))).toEqual([{ type: 'delta', quest_id: QUEST, slot: 0, text: 'lo' }]);
  });

  it('sends nothing for a duplicate frame', () => {
    const differ = new TurnReplyDiffer(QUEST);
    differ.observe(frame(['Hello']));
    expect(differ.observe(frame(['Hello']))).toEqual([]);
  });

  it('replaces a slot whose new text does not extend the old', () => {
    const differ = new TurnReplyDiffer(QUEST);
    differ.observe(frame(['Hello wor']));
    expect(differ.observe(frame(['Retry']))).toEqual([{ type: 'replace', quest_id: QUEST, slot: 0, text: 'Retry' }]);
  });

  it('clears slots that a reset emptied, then streams the rebuilt slot from scratch', () => {
    const differ = new TurnReplyDiffer(QUEST);
    differ.observe(frame(['thinking', 'answer']));
    expect(differ.observe(frame([]))).toEqual([
      { type: 'replace', quest_id: QUEST, slot: 0, text: '' },
      { type: 'replace', quest_id: QUEST, slot: 1, text: '' },
    ]);
    expect(differ.observe(frame(['again']))).toEqual([{ type: 'delta', quest_id: QUEST, slot: 0, text: 'again' }]);
  });

  it('diffs each slot independently', () => {
    const differ = new TurnReplyDiffer(QUEST);
    differ.observe(frame(['Let me think']));
    expect(differ.observe(frame(['Let me think.', 'The answer']))).toEqual([
      { type: 'delta', quest_id: QUEST, slot: 0, text: '.' },
      { type: 'delta', quest_id: QUEST, slot: 1, text: 'The answer' },
    ]);
  });

  it('reads `reply` as the only slot when no reply slot is filled', () => {
    const differ = new TurnReplyDiffer(QUEST);
    expect(differ.observe({ id: QUEST, replies: [], reply: 'Session not found.' })).toEqual([
      { type: 'delta', quest_id: QUEST, slot: 0, text: 'Session not found.' },
    ]);
  });

  it('ignores another quest', () => {
    const differ = new TurnReplyDiffer(QUEST);
    expect(differ.observe({ id: 'quest-2', replies: ['other'] })).toEqual([]);
    expect(differ.settle({ id: 'quest-2', status: 'done', replies: ['other'] })).toEqual([]);
  });

  it('settles once from a terminal snapshot, flushing unsent slot text first', () => {
    const differ = new TurnReplyDiffer(QUEST);
    differ.observe(frame(['Hello']));
    const terminal = frame(['Hello world'], { status: 'stopped', creditsUsed: 4, errorCode: 'insufficient_credits' });
    expect(differ.settle(terminal)).toEqual([
      { type: 'delta', quest_id: QUEST, slot: 0, text: ' world' },
      {
        type: 'settled',
        quest_id: QUEST,
        status: 'stopped',
        failed: true,
        credits_used: 4,
        error_code: 'insufficient_credits',
      },
    ]);
    expect(differ.isSettled).toBe(true);
    expect(differ.settle(terminal)).toEqual([]);
    expect(differ.observe(frame(['Hello world, more']))).toEqual([]);
  });

  it('does not settle on a running snapshot and drops an unknown error code', () => {
    const differ = new TurnReplyDiffer(QUEST);
    expect(differ.settle(frame(['x']))).toEqual([]);
    expect(differ.settle(frame(['x'], { status: 'done', errorCode: 'not_a_code' })).at(-1)).toEqual({
      type: 'settled',
      quest_id: QUEST,
      status: 'done',
      failed: false,
    });
  });

  it('marks an error-typed quest failed even with no error code', () => {
    const differ = new TurnReplyDiffer(QUEST);
    expect(differ.settle(frame(['Not allowed'], { status: 'done', type: 'error' })).at(-1)).toEqual({
      type: 'settled',
      quest_id: QUEST,
      status: 'done',
      failed: true,
    });
  });
});

describe('createTurnFrameTee', () => {
  const action = (questId: string) => ({
    action: 'streamed_chat_completion' as const,
    quest: { id: questId, sessionId: 's1', replies: ['hi'], status: 'running' as const },
    statusMessage: '',
  });

  it('forwards every frame to the real sender and hands only this quest to onFrame', async () => {
    const forward = { sendToClient: vi.fn().mockResolvedValue(undefined) };
    const onFrame = vi.fn();
    const tee = createTurnFrameTee({ questId: QUEST, forward, onFrame });

    await tee.sendToClient('u1', 'wss://ws', action(QUEST) as never);
    await tee.sendToClient('u1', 'wss://ws', action('quest-2') as never);
    await tee.sendToClient('u1', 'wss://ws', { action: 'invalidate_query', queryKey: ['x'] } as never);

    expect(forward.sendToClient).toHaveBeenCalledTimes(3);
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(onFrame).toHaveBeenCalledWith(expect.objectContaining({ id: QUEST, replies: ['hi'] }));
  });

  it('returns the real send result unchanged', async () => {
    const failure = new Error('gone');
    const forward = { sendToClient: vi.fn().mockRejectedValue(failure) };
    const tee = createTurnFrameTee({ questId: QUEST, forward, onFrame: vi.fn() });

    await expect(tee.sendToClient('u1', 'wss://ws', action(QUEST) as never)).rejects.toBe(failure);
  });
});
