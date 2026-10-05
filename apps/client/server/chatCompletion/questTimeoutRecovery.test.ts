import { describe, it, expect } from 'vitest';
import {
  ABANDONED_RUN,
  UNFINISHED_REPLY_NOTICE,
  applyRecoveryInMemory,
  resolveQuestTimeoutRecovery,
  terminalRecoveryFor,
  QUEST_TIMEOUT_THRESHOLD_MS,
  type QuestTimeoutView,
} from './questTimeoutRecovery';

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
      fallbackInfo: null,
    });
  });

  it('preserves images on a stale running quest (killed after the render was stored) - #313', () => {
    // The chat image path: preamble replies + a stored image, but the terminal frame was lost.
    // Content must survive and no "try again" notice is added, since that would re-run a paid
    // generation; the finishReason stamp still records that the run died.
    const recovery = resolveQuestTimeoutRecovery(quest({ replies: ['Here is your dog:'], images: ['dog.png'] }), NOW);
    expect(recovery).toEqual({ status: 'done', finishReason: 'timeout' });
  });

  it('drops fallbackInfo when only media survived, since the failed primary may have produced it', () => {
    const recovery = resolveQuestTimeoutRecovery(quest({ replies: [], images: ['primary.png'] }), NOW);
    expect(recovery).toEqual({ status: 'done', finishReason: 'timeout', fallbackInfo: null });
  });

  // #3356: a run hard-killed mid tool call used to settle as a clean `done` / `message`, so a
  // polling caller could not tell the partial preamble from a finished answer.
  it('keeps partial reply slots, appends the unfinished notice, and stamps finishReason', () => {
    const recovery = resolveQuestTimeoutRecovery(
      quest({ replies: ['<think>plan</think>', 'Let me search for that.'], reply: 'Let me search for that.' }),
      NOW
    );
    expect(recovery).toEqual({
      status: 'done',
      finishReason: 'timeout',
      replies: ['<think>plan</think>', 'Let me search for that.', `\n\n${UNFINISHED_REPLY_NOTICE}`],
      reply: `Let me search for that.\n\n${UNFINISHED_REPLY_NOTICE}`,
    });
    expect(recovery?.type).toBeUndefined();
  });

  it('appends the notice to `reply` when the quest carries no reply slots', () => {
    expect(resolveQuestTimeoutRecovery(quest({ reply: 'partial answer' }), NOW)).toEqual({
      status: 'done',
      finishReason: 'timeout',
      reply: `partial answer\n\n${UNFINISHED_REPLY_NOTICE}`,
    });
  });

  it('marks tool-only content unfinished without discarding it', () => {
    expect(resolveQuestTimeoutRecovery(quest({ toolResults: [{ content: 'rows' }] as never }), NOW)).toEqual({
      status: 'done',
      finishReason: 'timeout',
      finishReason: 'timeout',
      reply: `\n\n${UNFINISHED_REPLY_NOTICE}`,
    });
  });

  it('stamps the abandoned sweep with its own finishReason', () => {
    expect(terminalRecoveryFor({ replies: ['partial'] }, ABANDONED_RUN)).toMatchObject({
      status: 'done',
      finishReason: 'abandoned',
    });
  });

  it('treats an all-empty replies array as no content', () => {
    expect(resolveQuestTimeoutRecovery(quest({ replies: ['', ''] }), NOW)).toEqual({
      status: 'done',
      type: 'error',
      reply: 'This request timed out. The server did not respond in time. Please try again.',
      fallbackInfo: null,
    });
  });

  it('treats an unclosed <think> block as no content, not a real answer (#3223)', () => {
    // A process killed mid-stream can leave behind nothing but an unclosed reasoning marker -
    // that is real text (a bare truthy check would count it), but visibleReplyText hides it
    // entirely, so the recovery must still synthesize the timeout error.
    expect(resolveQuestTimeoutRecovery(quest({ replies: ['<think>some hidden reasoning'] }), NOW)).toEqual({
      status: 'done',
      type: 'error',
      reply: 'This request timed out. The server did not respond in time. Please try again.',
      fallbackInfo: null,
    });
    expect(resolveQuestTimeoutRecovery(quest({ reply: '<think>some hidden reasoning' }), NOW)).toEqual({
      status: 'done',
      type: 'error',
      reply: 'This request timed out. The server did not respond in time. Please try again.',
      fallbackInfo: null,
    });
  });

  it('clears a persisted fallbackInfo when the turn settles as an error, but keeps it when content survived', () => {
    // A timed-out run that had already switched models must not keep claiming a model answered it.
    const empty = resolveQuestTimeoutRecovery(quest({ replies: [] }), NOW);
    expect(empty).toMatchObject({ type: 'error', fallbackInfo: null });

    const partial = resolveQuestTimeoutRecovery(quest({ replies: ['half an answer'] }), NOW);
    expect(partial).not.toHaveProperty('fallbackInfo');
  });

  it('does not recover exactly at the threshold (strictly older required)', () => {
    const exactlyAtThreshold = new Date(NOW - QUEST_TIMEOUT_THRESHOLD_MS);
    expect(resolveQuestTimeoutRecovery(quest({ updatedAt: exactlyAtThreshold }), NOW)).toBeNull();
  });
});

describe('applyRecoveryInMemory', () => {
  it('merges finishReason into promptMeta instead of writing it as a top-level field', () => {
    const q: Parameters<typeof applyRecoveryInMemory>[0] = { status: 'running', promptMeta: { model: 'm' } as never };
    applyRecoveryInMemory(q, { status: 'done', finishReason: 'timeout', reply: 'x' });
    expect(q).toEqual({ status: 'done', reply: 'x', promptMeta: { model: 'm', finishReason: 'timeout' } });
  });
});
