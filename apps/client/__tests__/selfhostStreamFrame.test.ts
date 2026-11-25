// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { frameReplyText } from '../e2e/helpers/selfhostStreamFrame';

describe('frameReplyText', () => {
  it('reads a streamed answer from the reply slots when reply is null', () => {
    expect(frameReplyText({ reply: null, replies: ['one two', ' three'] })).toBe('one two three');
  });

  it('drops hidden reasoning from a slot', () => {
    expect(frameReplyText({ reply: null, replies: ['<think>counting</think>one two'] })).toBe('one two');
  });

  it('reports no text while only reasoning has streamed', () => {
    expect(frameReplyText({ reply: null, replies: ['<think>still counting'] })).toBe('');
  });

  it('falls back to reply when there are no slots', () => {
    expect(frameReplyText({ reply: 'The model call failed', replies: [] })).toBe('The model call failed');
    expect(frameReplyText({ reply: 'The model call failed' })).toBe('The model call failed');
  });

  it('returns an empty string for a frame with no text', () => {
    expect(frameReplyText({ reply: null })).toBe('');
    expect(frameReplyText({ replies: [null, 7] })).toBe('');
  });
});
