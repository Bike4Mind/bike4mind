import { describe, it, expect } from 'vitest';
import { buildMetaEvent, buildPublicSSEEvent, buildSSEEvent, formatSSEError, serializeSSEEvent } from './sseEvents';

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
  // chunk populates exactly one index (each backend declares streamedText inside its loop).
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
    // pushes one entry per response text block; every entry is response text, none droppable.
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

  // The text is forwarded verbatim. Reasoning is kept off a public stream by admitting
  // only models that cannot put it in the text channel (inlinesReasoningIntoText), never by
  // scanning content: on an admitted family `<think>` is ordinary prose, and truncating
  // there would bill the visitor for a reply they only partly received.
  it('forwards a literal <think> token an admitted model wrote as prose', () => {
    expect(buildPublicSSEEvent(['The literal <think> tag opens a reasoning block.']).text).toBe(
      'The literal <think> tag opens a reasoning block.'
    );
  });

  it('forwards a literal marker pair written as prose', () => {
    expect(buildPublicSSEEvent(['Write <think>...</think> around it.']).text).toBe(
      'Write <think>...</think> around it.'
    );
  });

  it('forwards a literal marker split across chunks', () => {
    // Nothing is held back now, so a token straddling two callbacks arrives in two pieces
    // that concatenate to the original - no chunk is dropped waiting for a marker.
    const chunks = [['The literal <'], ['th'], ['ink> tag.']];
    expect(chunks.map(c => buildPublicSSEEvent(c).text).join('')).toBe('The literal <think> tag.');
  });

  it('keeps trailing tag-prefix text that no chunk can follow', () => {
    // Single-shot: nothing comes after, so `<` is prose, not a split sentinel.
    expect(buildPublicSSEEvent(['the operator is <']).text).toBe('the operator is <');
  });

  // The channel tag is set by the adapter at the emit site, where reply prose, reasoning
  // and a raw tool result are still distinguishable. Downstream they are identical strings,
  // which is why this is a tag and not a content scan.
  it('drops the text of a reasoning frame', () => {
    // An adaptive Claude model opens a thinking block whether or not the request asked for
    // one, so the markers and any thinking text reach consumers on every turn.
    expect(buildPublicSSEEvent(['<think>'], { channel: 'reasoning' }).text).toBe('');
    expect(buildPublicSSEEvent(['deliberating about the user'], { channel: 'reasoning' }).text).toBe('');
  });

  it('drops the text of a raw tool-artifact frame', () => {
    // handleToolResultStreaming pushes the WHOLE tool result at index 0. For web_fetch that
    // is third-party page text; joining the sparse array would otherwise make it the reply.
    const page = '<artifact type="application/vnd.ant.react">raw third-party page body</artifact>';
    expect(buildPublicSSEEvent([page], { channel: 'tool-artifact' }).text).toBe('');
  });

  it('keeps usage accounting on a dropped frame', () => {
    const e = buildPublicSSEEvent(['<think>'], { channel: 'reasoning', outputTokens: 7, creditsUsed: 1 });
    expect(e.text).toBe('');
    expect(e.usage).toMatchObject({ outputTokens: 7 });
    expect(e.credits).toMatchObject({ used: 1 });
  });

  it('forwards an untagged frame, which is ordinary reply prose', () => {
    expect(buildPublicSSEEvent(['the answer'], { outputTokens: 5 }).text).toBe('the answer');
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
