import { describe, expect, it } from 'vitest';
import {
  buildCorrectionContextMessages,
  MAX_QUOTED_ANSWER_CHARS,
  MAX_QUOTED_PROMPT_CHARS,
} from './buildCorrectionContext';

describe('buildCorrectionContextMessages', () => {
  it('frames the latest message as a correction rather than a new question', () => {
    const [message] = buildCorrectionContextMessages({
      prompt: 'What was Q2 revenue?',
      replies: ['Q2 revenue was $4.1M.'],
    });

    expect(message.role).toBe('system');
    expect(message.content).toContain('CORRECTION');
    expect(message.content).toContain('not a new question');
    expect(message.content).toContain('What was Q2 revenue?');
    expect(message.content).toContain('Q2 revenue was $4.1M.');
  });

  it('tells the model to re-answer rather than merely apologise', () => {
    const [message] = buildCorrectionContextMessages({ replies: ['an answer'] });

    // The failure this guards is a turn that burns a completion on "Sorry, you're right!" and
    // never produces the corrected answer the user asked for.
    expect(message.content).toContain('apology');
    expect(message.content).toContain('corrected');
  });

  it('licenses the model to push back when the correction is itself wrong', () => {
    const [message] = buildCorrectionContextMessages({ replies: ['an answer'] });

    expect(message.content).toContain('If their correction is itself mistaken');
  });

  it('joins multi-part replies the way history reconstruction does', () => {
    const [message] = buildCorrectionContextMessages({ replies: ['first part', 'second part'] });

    expect(message.content).toContain('first part\nsecond part');
  });

  it('falls back to the single-string reply form on older turns', () => {
    const [message] = buildCorrectionContextMessages({ reply: 'legacy single reply' });

    expect(message.content).toContain('legacy single reply');
  });

  it('prefers replies over reply when a turn carries both', () => {
    const [message] = buildCorrectionContextMessages({ replies: ['canonical'], reply: 'legacy' });

    expect(message.content).toContain('canonical');
    expect(message.content).not.toContain('legacy');
  });

  it('omits the request block rather than quoting an empty one', () => {
    const [message] = buildCorrectionContextMessages({ prompt: '   ', replies: ['an answer'] });

    expect(message.content).not.toContain('The request it was answering was');
  });

  it('announces truncation of a long answer instead of silently cutting it', () => {
    const longAnswer = 'x'.repeat(MAX_QUOTED_ANSWER_CHARS + 500);
    const [message] = buildCorrectionContextMessages({ replies: [longAnswer] });

    expect(message.content).toContain('[...truncated]');
    expect(message.content).not.toContain('x'.repeat(MAX_QUOTED_ANSWER_CHARS + 1));
  });

  it('bounds the quoted request too', () => {
    const longPrompt = 'y'.repeat(MAX_QUOTED_PROMPT_CHARS + 500);
    const [message] = buildCorrectionContextMessages({ prompt: longPrompt, replies: ['an answer'] });

    expect(message.content).not.toContain('y'.repeat(MAX_QUOTED_PROMPT_CHARS + 1));
  });

  // The degradation contract: no referent means no framing. A message that quotes an empty answer
  // invites the model to invent what it supposedly said, which is worse than an ordinary turn.
  it.each([
    ['a missing turn', null],
    ['an undefined turn', undefined],
    ['a turn with no answer recorded', { prompt: 'a question' }],
    ['a turn whose replies are empty', { prompt: 'a question', replies: [] }],
    ['a turn whose replies are blank strings', { prompt: 'a question', replies: ['', '  '] }],
    ['a turn whose reply is whitespace', { prompt: 'a question', reply: '   ' }],
    ['a turn whose reply is null', { prompt: 'a question', reply: null }],
  ])('emits nothing for %s', (_label, turn) => {
    expect(buildCorrectionContextMessages(turn)).toEqual([]);
  });
});
