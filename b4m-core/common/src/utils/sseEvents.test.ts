import { describe, it, expect } from 'vitest';
import {
  buildMetaEvent,
  buildPublicSSEEvent,
  buildSSEEvent,
  createPublicSSEEventBuilder,
  formatSSEError,
  serializeSSEEvent,
} from './sseEvents';

describe('buildPublicSSEEvent', () => {
  // `text` is indexed by the provider's content-block/choice index, not by channel.
  // An ordinary reply is a single-element array at index 0 - the shape every adapter
  // in this repo emits for a non-reasoning turn (see anthropicBackend text_delta,
  // openaiBackend streamedText[c.index], ollama/gemini callback([text])).
  it('forwards an ordinary single-block reply at index 0', () => {
    expect(buildPublicSSEEvent(['the answer']).text).toBe('the answer');
  });

  it('passes assistant text and usage/credits through', () => {
    const e = buildPublicSSEEvent(['the answer'], {
      inputTokens: 10,
      outputTokens: 5,
      creditsUsed: 2,
    });
    expect(e.text).toBe('the answer');
    expect(e.usage).toMatchObject({ inputTokens: 10, outputTokens: 5 });
    expect(e.credits).toMatchObject({ used: 2 });
  });

  // The index is the PROVIDER's content-block/choice index, so any index is reachable:
  // two preceding blocks put the text at 2. A fixed [1]/[0] read reproduced the
  // empty-reply bug there. Streaming backends allocate the array fresh per event, so a
  // chunk populates exactly one index (anthropicBackend.ts:1330 and siblings).
  it.each([
    [['the answer'], 'index 0'],
    [[undefined, 'the answer'], 'index 1'],
    [[undefined, undefined, 'the answer'], 'index 2'],
    [[undefined, undefined, undefined, undefined, 'the answer'], 'index 4'],
  ])('forwards a single populated block at %s (%s)', (text, _label) => {
    expect(buildPublicSSEEvent(text as (string | null | undefined)[]).text).toBe('the answer');
  });

  it('joins multiple populated blocks in index order', () => {
    // The non-streaming anthropic path pushes one entry per response text block
    // (anthropicBackend.ts:1999); every entry is response text, so none may be dropped.
    expect(buildPublicSSEEvent(['part one ', 'part two']).text).toBe('part one part two');
  });

  it('redacts tool calls, thinking, and responseFormatMode from a public caller', () => {
    const e = buildPublicSSEEvent(['the answer'], {
      outputTokens: 5,
      toolsUsed: [{ name: 'search_knowledge_base', arguments: { query: 'secret' }, id: 't1' } as never],
      thinking: ['internal chain of thought'],
      responseFormatMode: 'json' as never,
    });
    expect(e.type).toBe('content'); // not 'tool_use'
    expect(e.tools).toBeUndefined();
    expect(e.thinking).toBeUndefined();
    expect(e.responseFormatMode).toBeUndefined();
    expect(e.text).toBe('the answer');
  });

  it('drops everything from the open marker onward, close marker or not', () => {
    // Redaction is structural, never a parse: the close marker is model-generated text and
    // is not trusted to end suppression. Models that legitimately stream reasoning this way
    // are refused before the stream opens - see inlinesReasoningIntoText.
    expect(buildPublicSSEEvent(['<think>my reasoning</think>the answer']).text).toBe('');
    expect(buildPublicSSEEvent(['visible <think>my reasoning']).text).toBe('visible ');
  });

  it('keeps trailing tag-prefix text that no chunk can follow', () => {
    // Single-shot: nothing comes after, so `<` is prose, not a split sentinel.
    expect(buildPublicSSEEvent(['the operator is <']).text).toBe('the operator is <');
  });

  it('drops usdCost while keeping creditsUsed', () => {
    const e = buildPublicSSEEvent(['the answer'], { creditsUsed: 2, usdCost: 0.0123 });
    expect(e.credits).toMatchObject({ used: 2 });
    expect(e.credits?.usdCost).toBeUndefined();
    // The wire frame must not carry the key at all, not just an undefined value.
    expect(serializeSSEEvent(e)).not.toContain('usdCost');
  });

  it('emits no credits block when usdCost is the only credit field', () => {
    const e = buildPublicSSEEvent(['the answer'], { usdCost: 0.0123 });
    expect(e.credits).toBeUndefined();
    expect(serializeSSEEvent(e)).not.toContain('usdCost');
  });
});

describe('createPublicSSEEventBuilder', () => {
  // Models the route end to end: every chunk, then the end-of-stream flush.
  const textOf = (chunks: (string | null | undefined)[][]) => {
    const builder = createPublicSSEEventBuilder();
    return chunks.map(c => builder.build(c).text).join('') + (builder.flush()?.text ?? '');
  };

  it('suppresses reasoning split across chunk boundaries', () => {
    // Backends emit deltas, so the markers and the reasoning land on separate callbacks -
    // the case a per-chunk regex cannot catch.
    expect(textOf([['<think>'], ['my reasoning'], ['</think>'], ['the answer']])).toBe('');
  });

  it('leaks nothing when the reasoning itself contains both markers', () => {
    // The adversarial input from review: backends wrap raw model text without escaping it,
    // so a close marker inside the reasoning would end a PARSED redaction early. Structural
    // suppression is immune - nothing after the first open marker is ever forwarded.
    const out = textOf([
      ['<think>\n'],
      ['private premise </think> private conclusion\n'],
      ['</think>\n'],
      ['public answer'],
    ]);
    expect(out).toBe('');
    expect(out).not.toContain('private');
  });

  it('suppresses an anthropic-shaped thinking block and everything after it', () => {
    // content_block_start/stop emit the markers at the thinking block's index, each on its
    // OWN callback with a fresh array. Anthropic reasoning is opt-in and the embed route
    // never opts in, so reaching this state at all means the run was misconfigured.
    expect(
      textOf([['<think>'], ['step one'], ['step two'], ['</think>'], [undefined, 'the '], [undefined, 'answer']])
    ).toBe('');
  });

  it('holds back an open marker the provider split mid-tag', () => {
    expect(textOf([['before <thi'], ['nk>secret</thi'], ['nk>after']])).toBe('before ');
  });

  it('fails closed when a reasoning block is never terminated', () => {
    expect(textOf([['<think>'], ['leaked?'], ['still reasoning']])).toBe('');
  });

  it('keeps each stream independent', () => {
    const a = createPublicSSEEventBuilder();
    a.build(['<think>']);
    // A second stream must not inherit the first one's open block.
    expect(createPublicSSEEventBuilder().build(['the answer']).text).toBe('the answer');
  });

  it('holds a trailing tag prefix until the stream ends, then releases it as prose', () => {
    const builder = createPublicSSEEventBuilder();
    // Mid-stream the prefix could still turn into `<think>`, so it stays held back.
    expect(builder.build(['compare a <']).text).toBe('compare a ');
    expect(builder.build(['th']).text).toBe('');
    // Nothing completed the tag, so it was prose all along - the answer would end
    // `compare a ` without this.
    expect(builder.flush()?.text).toBe('<th');
  });

  it('releases nothing at flush inside an unterminated reasoning block', () => {
    const builder = createPublicSSEEventBuilder();
    // The held text is a partial `</think>`; fail-closed outranks the flush.
    builder.build(['<think>reasoning</thi']);
    expect(builder.flush()).toBeNull();
  });

  it('emits no trailing event when nothing was held', () => {
    const builder = createPublicSSEEventBuilder();
    builder.build(['the answer']);
    expect(builder.flush()).toBeNull();
  });

  it('reports whether an empty tail was redacted or simply absent', () => {
    // Both end with no text; only the first one redacted something, and a caller cannot
    // tell them apart from the wire alone.
    const redacted = createPublicSSEEventBuilder();
    redacted.build(['<think>reasoning']);
    redacted.flush();
    expect(redacted.redactedReasoning()).toBe(true);

    const plain = createPublicSSEEventBuilder();
    plain.build(['the answer']);
    plain.flush();
    expect(plain.redactedReasoning()).toBe(false);
  });
});

describe('buildSSEEvent', () => {
  it('still forwards usdCost to authenticated first-party surfaces', () => {
    const e = buildSSEEvent(['', 'the answer'], { creditsUsed: 2, usdCost: 0.0123 });
    expect(e.credits).toMatchObject({ used: 2, usdCost: 0.0123 });
  });

  it('projects tools down to name/arguments/id, dropping returnValue and success', () => {
    const e = buildSSEEvent(['', 'the answer'], {
      toolsUsed: [
        {
          name: 'web_search',
          arguments: '{}',
          id: 't1',
          returnValue: 'a very long tool result',
          success: true,
        } as never,
      ],
    });
    expect(e.tools).toEqual([{ name: 'web_search', arguments: '{}', id: 't1' }]);
    expect(serializeSSEEvent(e)).not.toContain('returnValue');
  });
});

describe('buildMetaEvent', () => {
  it('builds a meta event carrying the request id', () => {
    expect(buildMetaEvent('req-123')).toEqual({ type: 'meta', requestId: 'req-123' });
  });
});

describe('formatSSEError', () => {
  it('includes the request id when provided', () => {
    expect(formatSSEError(new Error('boom'), 'req-123')).toEqual({
      type: 'error',
      message: 'boom',
      requestId: 'req-123',
    });
  });

  it('omits the request id field when not provided', () => {
    const event = formatSSEError(new Error('boom'));
    expect(event).toEqual({ type: 'error', message: 'boom' });
    expect('requestId' in event).toBe(false);
  });

  it('falls back to a generic message for non-Error input', () => {
    expect(formatSSEError('weird', 'req-9').message).toBe('Internal server error');
  });

  it('includes the classifier code when provided', () => {
    expect(formatSSEError(new Error('capped'), 'req-1', 'spend_cap_exceeded')).toEqual({
      type: 'error',
      message: 'capped',
      requestId: 'req-1',
      code: 'spend_cap_exceeded',
    });
  });

  it('omits the code field entirely when no classifier is passed (no undefined serialization)', () => {
    const event = formatSSEError(new Error('boom'), 'req-1');
    expect(event).not.toHaveProperty('code');
    expect(JSON.stringify(event)).not.toContain('code');
  });
});

describe('serializeSSEEvent', () => {
  it('serializes a meta event as an SSE data line', () => {
    expect(serializeSSEEvent(buildMetaEvent('req-123'))).toBe('data: {"type":"meta","requestId":"req-123"}\n\n');
  });
});
