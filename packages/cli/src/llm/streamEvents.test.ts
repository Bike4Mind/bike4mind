import { describe, it, expect } from 'vitest';
import { parseStreamEvent } from './streamEvents';

describe('parseStreamEvent', () => {
  it('parses a content event with text, usage and credits', () => {
    const event = parseStreamEvent({
      type: 'content',
      text: 'hello',
      usage: { inputTokens: 1, outputTokens: 2 },
      credits: { used: 3, usdCost: 0.04 },
    });
    expect(event).toEqual({
      type: 'content',
      text: 'hello',
      usage: { inputTokens: 1, outputTokens: 2 },
      credits: { used: 3, usdCost: 0.04 },
    });
  });

  // Regression guard: the wire format for `tools` is { name, arguments?: string, id? }
  // (see SSEContentEvent.tools / CompletionInfo.toolsUsed in @bike4mind/common).
  // A schema that required `input` here would reject every real tool_use event,
  // return null, and silently drop tool calls - exactly the bug this asserts against.
  it('parses a tool_use event in the real wire shape (name/arguments/id) and keeps it non-null', () => {
    const event = parseStreamEvent({
      type: 'tool_use',
      text: '',
      tools: [{ name: 'read_file', arguments: '{"path":"/tmp/x"}', id: 'toolu_abc' }],
      thinking: [{ type: 'thinking', thinking: 'why', signature: 'sig' }],
    });
    expect(event).not.toBeNull();
    expect(event?.type).toBe('tool_use');
    expect(event && event.type === 'tool_use' && event.tools).toEqual([
      { name: 'read_file', arguments: '{"path":"/tmp/x"}', id: 'toolu_abc' },
    ]);
  });

  it('keeps Anthropic cache-token deltas on usage (not stripped at the boundary)', () => {
    const event = parseStreamEvent({
      type: 'content',
      text: 'x',
      usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 7, cacheCreationInputTokens: 3 },
    });
    expect(event && event.type === 'content' && event.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 7,
      cacheCreationInputTokens: 3,
    });
  });

  it('parses an error event', () => {
    expect(parseStreamEvent({ type: 'error', message: 'boom' })).toEqual({
      type: 'error',
      message: 'boom',
    });
  });

  it('strips unknown keys not part of the event shape', () => {
    const event = parseStreamEvent({ type: 'content', text: 'hi', bogus: 'drop me' });
    expect(event).toEqual({ type: 'content', text: 'hi' });
  });

  it('returns null for an unrecognized event type (skip semantics)', () => {
    expect(parseStreamEvent({ type: 'message_start', text: 'x' })).toBeNull();
  });

  it('returns null when a known event has a malformed field', () => {
    expect(parseStreamEvent({ type: 'content', text: 123 })).toBeNull();
  });

  it('returns null for non-object payloads', () => {
    expect(parseStreamEvent('[DONE]')).toBeNull();
    expect(parseStreamEvent(null)).toBeNull();
  });

  // This schema strips unknown keys, so an undeclared field is dropped at the boundary no
  // matter what the server sends - which is exactly how the truncation signal went missing.
  it('preserves stopReason on content and tool_use events', () => {
    expect(parseStreamEvent({ type: 'content', text: 'cut', stopReason: 'max_tokens' })).toEqual({
      type: 'content',
      text: 'cut',
      stopReason: 'max_tokens',
    });
    expect(parseStreamEvent({ type: 'tool_use', text: '', stopReason: 'max_tokens' })).toEqual({
      type: 'tool_use',
      text: '',
      stopReason: 'max_tokens',
    });
  });

  // Left as a free-form string on purpose: a provider-specific or newly-added reason must
  // reach the client rather than fail validation and drop the whole event.
  it('accepts an unrecognized stop reason verbatim', () => {
    expect(parseStreamEvent({ type: 'content', text: 'x', stopReason: 'some_future_reason' })).toEqual({
      type: 'content',
      text: 'x',
      stopReason: 'some_future_reason',
    });
  });
});
