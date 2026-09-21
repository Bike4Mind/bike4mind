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

  it('prefers the later block when the backend opened a second one', () => {
    // Anthropic puts the text block after a thinking block, so index 1 wins over
    // index 0 and the index-0 fallback cannot leak it.
    expect(buildPublicSSEEvent(['reasoning', 'the answer']).text).toBe('the answer');
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

  it('strips an inline <think> block that arrives whole in one chunk', () => {
    expect(buildPublicSSEEvent(['<think>my reasoning</think>the answer']).text).toBe('the answer');
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
  const textOf = (chunks: (string | null | undefined)[][]) => {
    const build = createPublicSSEEventBuilder();
    return chunks.map(c => build(c).text).join('');
  };

  it('suppresses reasoning split across chunk boundaries', () => {
    // Backends emit deltas, so the sentinels and the reasoning land on separate
    // callbacks - the case a per-chunk regex cannot catch.
    expect(textOf([['<think>'], ['my reasoning'], ['</think>'], ['the answer']])).toBe('the answer');
  });

  it('suppresses an anthropic-shaped thinking block that precedes the text block', () => {
    // content_block_start/stop emit the sentinels at the thinking block's index;
    // the reply then streams at the text block's index.
    expect(
      textOf([['<think>'], ['step one'], ['step two'], ['</think>'], [undefined, 'the '], [undefined, 'answer']])
    ).toBe('the answer');
  });

  it('holds back a sentinel the provider split mid-tag', () => {
    expect(textOf([['before <thi'], ['nk>secret</thi'], ['nk>after']])).toBe('before after');
  });

  it('fails closed when a reasoning block is never terminated', () => {
    expect(textOf([['<think>'], ['leaked?'], ['still reasoning']])).toBe('');
  });

  it('keeps each stream independent', () => {
    const a = createPublicSSEEventBuilder();
    a(['<think>']);
    // A second stream must not inherit the first one's open block.
    expect(createPublicSSEEventBuilder()(['the answer']).text).toBe('the answer');
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
