import { describe, it, expect } from 'vitest';
import { resolveQuestTimeoutRecovery, QUEST_TIMEOUT_THRESHOLD_MS, type QuestTimeoutView } from './questTimeoutRecovery';

const NOW = 1_000_000_000_000;
const STALE = new Date(NOW - QUEST_TIMEOUT_THRESHOLD_MS - 1_000);
const FRESH = new Date(NOW - 5_000);

const quest = (overrides: Partial<QuestTimeoutView>): QuestTimeoutView => ({
  status: 'running',
  updatedAt: STALE,
  ...overrides,
});

describe('resolveQuestTimeoutRecovery', () => {
  it('leaves a fresh running quest alone (heartbeat keeps a live run fresh)', () => {
    expect(resolveQuestTimeoutRecovery(quest({ updatedAt: FRESH }), NOW)).toBeNull();
  });

  it('leaves an already-terminal quest alone so its intact state is returned as-is (lost-frame recovery)', () => {
    expect(resolveQuestTimeoutRecovery(quest({ status: 'done', images: ['dog.png'] }), NOW)).toBeNull();
    expect(resolveQuestTimeoutRecovery(quest({ status: 'stopped' }), NOW)).toBeNull();
  });

  it('recovers a stale running quest with NO content as a timeout error', () => {
    const recovery = resolveQuestTimeoutRecovery(quest({ replies: [], reply: null }), NOW);
    expect(recovery).toEqual({
      status: 'done',
      type: 'error',
      reply: 'This request timed out. The server did not respond in time. Please try again.',
    });
  });

  it('preserves images on a stale running quest (killed after the render was stored) - #313', () => {
    // The chat image path: preamble replies + a stored image, but the terminal frame was lost.
    // Content must survive - flip status only, never clobber with an error.
    const recovery = resolveQuestTimeoutRecovery(quest({ replies: ['Here is your dog:'], images: ['dog.png'] }), NOW);
    expect(recovery).toEqual({ status: 'done' });
  });

  it('preserves partial text replies on a stale running quest (no error clobber)', () => {
    expect(resolveQuestTimeoutRecovery(quest({ replies: ['partial answer'] }), NOW)).toEqual({ status: 'done' });
    expect(resolveQuestTimeoutRecovery(quest({ reply: 'partial answer' }), NOW)).toEqual({ status: 'done' });
  });

  it('treats an all-empty replies array as no content', () => {
    expect(resolveQuestTimeoutRecovery(quest({ replies: ['', ''] }), NOW)).toEqual({
      status: 'done',
      type: 'error',
      reply: 'This request timed out. The server did not respond in time. Please try again.',
    });
  });

  it('does not recover exactly at the threshold (strictly older required)', () => {
    const exactlyAtThreshold = new Date(NOW - QUEST_TIMEOUT_THRESHOLD_MS);
    expect(resolveQuestTimeoutRecovery(quest({ updatedAt: exactlyAtThreshold }), NOW)).toBeNull();
  });
});
