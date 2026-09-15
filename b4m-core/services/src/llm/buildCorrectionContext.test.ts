import { describe, expect, it, vi } from 'vitest';
import {
  buildCorrectionContextMessages,
  resolveCorrectionContext,
  MAX_QUOTED_ANSWER_CHARS,
  MAX_QUOTED_PROMPT_CHARS,
  type CorrectedTurn,
} from './buildCorrectionContext';

/** The framing sentence, which is what the model is actually instructed by. */
const framingOf = (turn: CorrectedTurn | null | undefined) =>
  buildCorrectionContextMessages(turn).correction[0]?.content as string | undefined;

/** The quoted request/answer, ranked apart so the budget can drop it on its own. */
const quoteOf = (turn: CorrectedTurn | null | undefined) =>
  buildCorrectionContextMessages(turn).correctionQuote[0]?.content as string | undefined;

const textBlocks = (...texts: string[]) => [{ content: texts.map(text => ({ type: 'text' as const, text })) }];

describe('buildCorrectionContextMessages', () => {
  it('frames the latest message as a correction rather than a new question', () => {
    const { correction } = buildCorrectionContextMessages({
      prompt: 'What was Q2 revenue?',
      replies: ['Q2 revenue was $4.1M.'],
    });

    expect(correction[0].role).toBe('system');
    expect(correction[0].content).toContain('CORRECTION');
    expect(correction[0].content).toContain('not a new question');
  });

  it('tells the model to re-answer rather than merely apologise', () => {
    // The failure this guards is a turn that burns a completion on "Sorry, you're right!" and
    // never produces the corrected answer the user asked for.
    expect(framingOf({ replies: ['an answer'] })).toContain('apology');
    expect(framingOf({ replies: ['an answer'] })).toContain('corrected');
  });

  it('licenses the model to push back when the correction is itself wrong', () => {
    expect(framingOf({ replies: ['an answer'] })).toContain('If their correction is itself mistaken');
  });

  it('quotes the request and the answer being corrected', () => {
    const quote = quoteOf({ prompt: 'What was Q2 revenue?', replies: ['Q2 revenue was $4.1M.'] });

    expect(quote).toContain('What was Q2 revenue?');
    expect(quote).toContain('Q2 revenue was $4.1M.');
  });

  // The split exists so budget pressure drops up to 5000 characters of mostly-duplicated quote
  // instead of the org/session prompts. That only works if the instruction survives alone.
  it('keeps the instruction free of the quote, so evicting one leaves the other standing', () => {
    const framing = framingOf({ prompt: 'What was Q2 revenue?', replies: ['Q2 revenue was $4.1M.'] });

    expect(framing).not.toContain('Q2 revenue was $4.1M.');
    expect(framing).not.toContain('What was Q2 revenue?');
  });

  it('emits the two halves as separately rankable sources', () => {
    const messages = buildCorrectionContextMessages({ replies: ['an answer'] });

    expect(messages.correction).toHaveLength(1);
    expect(messages.correctionQuote).toHaveLength(1);
    expect(messages.correctionQuote[0].role).toBe('system');
  });

  it('joins multi-part replies the way history reconstruction does', () => {
    expect(quoteOf({ replies: ['first part', 'second part'] })).toContain('first part\nsecond part');
  });

  it('falls back to the single-string reply form on older turns', () => {
    expect(quoteOf({ reply: 'legacy single reply' })).toContain('legacy single reply');
  });

  it('prefers replies over reply when a turn carries both', () => {
    const quote = quoteOf({ replies: ['canonical'], reply: 'legacy' });

    expect(quote).toContain('canonical');
    expect(quote).not.toContain('legacy');
  });

  // A tool-heavy or thinking-format turn records its prose in structuredReplies and can leave
  // replies/reply empty. Reading only the latter made such a turn look like it never answered, so
  // the correction silently lost its framing on exactly the turns most worth correcting.
  describe('structuredReplies', () => {
    it('reads the answer out of structured text blocks', () => {
      expect(quoteOf({ structuredReplies: textBlocks('the structured answer') })).toContain('the structured answer');
    });

    it('prefers structured text over replies, matching estimateQuestTokenLength', () => {
      const quote = quoteOf({ structuredReplies: textBlocks('structured'), replies: ['flat'] });

      expect(quote).toContain('structured');
      expect(quote).not.toContain('flat');
    });

    it('joins multiple text blocks across multiple structured replies', () => {
      const quote = quoteOf({
        structuredReplies: [...textBlocks('first'), ...textBlocks('second')],
      });

      expect(quote).toContain('first\nsecond');
    });

    it('quotes only prose, never the serialized tool_use blocks beside it', () => {
      const quote = quoteOf({
        structuredReplies: [
          {
            content: [
              { type: 'tool_use', id: 'tu-1', name: 'search', input: { query: 'secret-tool-input' } },
              { type: 'text', text: 'the prose answer' },
            ],
          },
        ] as CorrectedTurn['structuredReplies'],
      });

      expect(quote).toContain('the prose answer');
      expect(quote).not.toContain('secret-tool-input');
    });

    // Deliberately unlike estimateQuestTokenLength, which stops at `structuredReplies?.length`:
    // what is wanted here is prose to quote, so a turn that only called tools falls through.
    it('falls through to replies when the structured blocks carry no text', () => {
      const quote = quoteOf({
        structuredReplies: [
          { content: [{ type: 'tool_use', id: 'tu-1', name: 'search', input: {} }] },
        ] as CorrectedTurn['structuredReplies'],
        replies: ['the flat answer'],
      });

      expect(quote).toContain('the flat answer');
    });
  });

  it('omits the request block rather than quoting an empty one', () => {
    expect(quoteOf({ prompt: '   ', replies: ['an answer'] })).not.toContain('The request it was answering was');
  });

  it('announces truncation of a long answer instead of silently cutting it', () => {
    const longAnswer = 'x'.repeat(MAX_QUOTED_ANSWER_CHARS + 500);
    const quote = quoteOf({ replies: [longAnswer] });

    expect(quote).toContain('[...truncated]');
    expect(quote).not.toContain('x'.repeat(MAX_QUOTED_ANSWER_CHARS + 1));
  });

  it('bounds the quoted request too', () => {
    const longPrompt = 'y'.repeat(MAX_QUOTED_PROMPT_CHARS + 500);

    expect(quoteOf({ prompt: longPrompt, replies: ['an answer'] })).not.toContain(
      'y'.repeat(MAX_QUOTED_PROMPT_CHARS + 1)
    );
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
    ['a turn whose structuredReplies are empty', { prompt: 'a question', structuredReplies: [] }],
    ['a turn whose structured text is blank', { prompt: 'a question', structuredReplies: textBlocks('  ') }],
  ])('emits nothing for %s', (_label, turn) => {
    expect(buildCorrectionContextMessages(turn)).toEqual({ correction: [], correctionQuote: [] });
  });
});

describe('resolveCorrectionContext', () => {
  const SESSION = 'session-A';
  const makeLogger = () => ({ warn: vi.fn() });
  const reader = (doc: unknown) => ({ findById: vi.fn().mockResolvedValue(doc) });

  it('frames a correction whose target lives in the same session', async () => {
    const quests = reader({ sessionId: SESSION, prompt: 'a question', replies: ['an answer'] });

    const messages = await resolveCorrectionContext(
      { correctsQuestId: 'quest-1', sessionId: SESSION },
      quests,
      makeLogger()
    );

    expect(quests.findById).toHaveBeenCalledWith('quest-1');
    expect(messages.correction).toHaveLength(1);
    expect(messages.correctionQuote[0].content).toContain('an answer');
  });

  // The gate that makes a stale pointer harmless. A session copy used to spread `correctsQuestId`
  // into the new session, and the copied link still resolved - into the session it came from.
  it('refuses a link that names a quest in another session, quoting nothing', async () => {
    const logger = makeLogger();
    const quests = reader({ sessionId: 'session-B', prompt: 'other', replies: ['another session answer'] });

    const messages = await resolveCorrectionContext({ correctsQuestId: 'quest-1', sessionId: SESSION }, quests, logger);

    expect(messages).toEqual({ correction: [], correctionQuote: [] });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('cross-session'));
  });

  it('does not read the store at all for an ordinary turn', async () => {
    const quests = reader(null);

    const messages = await resolveCorrectionContext({ sessionId: SESSION }, quests, makeLogger());

    expect(quests.findById).not.toHaveBeenCalled();
    expect(messages).toEqual({ correction: [], correctionQuote: [] });
  });

  it('warns and degrades when the corrected turn is gone', async () => {
    const logger = makeLogger();

    const messages = await resolveCorrectionContext(
      { correctsQuestId: 'quest-1', sessionId: SESSION },
      reader(null),
      logger
    );

    expect(messages).toEqual({ correction: [], correctionQuote: [] });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('gone'));
  });

  it('warns and degrades when the corrected turn recorded no answer', async () => {
    const logger = makeLogger();

    const messages = await resolveCorrectionContext(
      { correctsQuestId: 'quest-1', sessionId: SESSION },
      reader({ sessionId: SESSION, prompt: 'a question' }),
      logger
    );

    expect(messages).toEqual({ correction: [], correctionQuote: [] });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('missing a recorded answer'));
  });

  it('stays quiet on the happy path', async () => {
    const logger = makeLogger();

    await resolveCorrectionContext(
      { correctsQuestId: 'quest-1', sessionId: SESSION },
      reader({ sessionId: SESSION, replies: ['an answer'] }),
      logger
    );

    expect(logger.warn).not.toHaveBeenCalled();
  });
});
