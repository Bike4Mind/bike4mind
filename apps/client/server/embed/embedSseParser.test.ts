import { describe, expect, it, vi } from 'vitest';
import { EMBED_SSE_PARSER_SRC } from './embedSseParser';
import {
  buildMetaEvent,
  buildSSEEvent,
  formatSSEError,
  serializeSSEEvent,
  SSE_DONE_SIGNAL,
  SSE_KEEPALIVE,
} from '@bike4mind/common';

interface ParserHandlers {
  onMeta?: (requestId: string) => void;
  onContent?: (delta: string) => void;
  onError?: (message: string) => void;
  onDone?: () => void;
}
interface Parser {
  push: (chunk: string) => void;
  flush: () => void;
  isDone: () => boolean;
}

// The parser ships as a source string inside the widget page; build it the way
// the browser would and drive it with frames from the REAL serializer, so the
// two sides of the wire cannot drift apart silently.
function makeParser(handlers: ParserHandlers): Parser {
  const factory = new Function(`return (${EMBED_SSE_PARSER_SRC})`)() as (h: ParserHandlers) => Parser;
  return factory(handlers);
}

describe('embed widget SSE parser vs the real serializer', () => {
  it('dispatches meta, content deltas, and done for a healthy stream', () => {
    const onMeta = vi.fn();
    const onContent = vi.fn();
    const onDone = vi.fn();
    const parser = makeParser({ onMeta, onContent, onDone });

    parser.push(SSE_KEEPALIVE);
    parser.push(serializeSSEEvent(buildMetaEvent('req-1')));
    parser.push(serializeSSEEvent(buildSSEEvent(['', 'Hel'])));
    parser.push(serializeSSEEvent(buildSSEEvent(['', 'lo'])));
    parser.push(SSE_DONE_SIGNAL);

    expect(onMeta).toHaveBeenCalledWith('req-1');
    expect(onContent.mock.calls.map(c => c[0])).toEqual(['Hel', 'lo']);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(parser.isDone()).toBe(true);
  });

  it('reassembles a frame split across push chunks', () => {
    const onContent = vi.fn();
    const parser = makeParser({ onContent });
    const frame = serializeSSEEvent(buildSSEEvent(['', 'split across chunks']));

    parser.push(frame.slice(0, 12));
    expect(onContent).not.toHaveBeenCalled();
    parser.push(frame.slice(12));
    expect(onContent).toHaveBeenCalledWith('split across chunks');
  });

  it('handles multiple frames arriving in one chunk', () => {
    const onContent = vi.fn();
    const onDone = vi.fn();
    const parser = makeParser({ onContent, onDone });

    parser.push(
      serializeSSEEvent(buildSSEEvent(['', 'a'])) + serializeSSEEvent(buildSSEEvent(['', 'b'])) + SSE_DONE_SIGNAL
    );
    expect(onContent.mock.calls.map(c => c[0])).toEqual(['a', 'b']);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('treats a tool_use frame as content (no tool UI on the embed surface)', () => {
    const onContent = vi.fn();
    const parser = makeParser({ onContent });
    parser.push(serializeSSEEvent(buildSSEEvent(['', 'tool delta'], { toolsUsed: [{ name: 'search' }] })));
    expect(onContent).toHaveBeenCalledWith('tool delta');
  });

  it('dispatches a mid-stream error frame and stops consuming', () => {
    const onContent = vi.fn();
    const onError = vi.fn();
    const onDone = vi.fn();
    const parser = makeParser({ onContent, onError, onDone });

    parser.push(serializeSSEEvent(buildSSEEvent(['', 'before'])));
    parser.push(serializeSSEEvent(formatSSEError(new Error('boom'), 'req-9')));
    parser.push(serializeSSEEvent(buildSSEEvent(['', 'after'])));
    parser.push(SSE_DONE_SIGNAL);

    expect(onContent.mock.calls.map(c => c[0])).toEqual(['before']);
    expect(onError).toHaveBeenCalledWith('boom');
    expect(onDone).not.toHaveBeenCalled();
    expect(parser.isDone()).toBe(true);
  });

  it('ignores a malformed data line and keeps parsing later frames', () => {
    const onContent = vi.fn();
    const parser = makeParser({ onContent });
    parser.push('data: {not json\n\n');
    parser.push(serializeSSEEvent(buildSSEEvent(['', 'still alive'])));
    expect(onContent).toHaveBeenCalledWith('still alive');
  });

  it('ignores frames after [DONE]', () => {
    const onContent = vi.fn();
    const onDone = vi.fn();
    const parser = makeParser({ onContent, onDone });
    parser.push(SSE_DONE_SIGNAL);
    parser.push(serializeSSEEvent(buildSSEEvent(['', 'late'])));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onContent).not.toHaveBeenCalled();
  });

  it('flush() processes a trailing partial frame (stream ended without DONE)', () => {
    const onContent = vi.fn();
    const parser = makeParser({ onContent });
    const frame = serializeSSEEvent(buildSSEEvent(['', 'tail']));
    parser.push(frame.slice(0, frame.length - 2)); // strip the terminating blank line
    parser.flush();
    expect(onContent).toHaveBeenCalledWith('tail');
    expect(parser.isDone()).toBe(false);
  });
});
