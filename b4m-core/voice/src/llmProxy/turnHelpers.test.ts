import { describe, it, expect, vi } from 'vitest';
import {
  stripSpokenThinking,
  currentTurnUserMessage,
  extractSystemPrompt,
  emitInitialBuffer,
  pickInitialBufferPhrase,
  INITIAL_BUFFER_PHRASES,
} from './turnHelpers';
import type { OpenAIChatRequest } from './translator';

type Messages = OpenAIChatRequest['messages'];

describe('stripSpokenThinking', () => {
  it('removes a complete <think> block and leading whitespace', () => {
    expect(stripSpokenThinking('<think>plan the answer</think>\n\nThe answer is 42.')).toBe('The answer is 42.');
  });

  it('withholds everything once a <think> block is still open', () => {
    expect(stripSpokenThinking('<think>still reasoning')).toBe('');
  });

  it('leaves plain replies untouched', () => {
    expect(stripSpokenThinking('Just a normal reply.')).toBe('Just a normal reply.');
  });
});

describe('currentTurnUserMessage', () => {
  it('returns the latest real user utterance', () => {
    const messages: Messages = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'what is the capital of Japan?' },
    ];
    expect(currentTurnUserMessage(messages)).toBe('what is the capital of Japan?');
  });

  it('treats the punctuation-only silence marker as no message', () => {
    expect(currentTurnUserMessage([{ role: 'user', content: '...' }])).toBeNull();
    expect(currentTurnUserMessage([{ role: 'user', content: '   ' }])).toBeNull();
  });

  it('returns null when the last message is not a user turn', () => {
    expect(currentTurnUserMessage([{ role: 'assistant', content: 'hello' }])).toBeNull();
  });
});

describe('extractSystemPrompt', () => {
  it('joins all system messages, trimmed', () => {
    const messages: Messages = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'hi' },
    ];
    expect(extractSystemPrompt(messages)).toBe('You are helpful.\n\nBe concise.');
  });

  it('returns empty string when there is no system message', () => {
    expect(extractSystemPrompt([{ role: 'user', content: 'hi' }])).toBe('');
  });
});

describe('pickInitialBufferPhrase', () => {
  it('always returns one of the configured phrases', () => {
    for (let i = 0; i < 30; i++) {
      expect(INITIAL_BUFFER_PHRASES).toContain(pickInitialBufferPhrase());
    }
  });

  it('every phrase ends with the "... " ElevenLabs buffer-words format requires', () => {
    for (const phrase of INITIAL_BUFFER_PHRASES) {
      expect(phrase.endsWith('... ')).toBe(true);
    }
  });
});

describe('emitInitialBuffer', () => {
  it('always emits a configured filler phrase', () => {
    const emit = vi.fn();
    emitInitialBuffer(emit);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(INITIAL_BUFFER_PHRASES).toContain(emit.mock.calls[0][0]);
  });

  it('emits on every call (no per-session dedupe)', () => {
    const emit = vi.fn();
    emitInitialBuffer(emit);
    emitInitialBuffer(emit);
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('emits a custom phrase when provided', () => {
    const emit = vi.fn();
    emitInitialBuffer(emit, 'One moment... ');
    expect(emit).toHaveBeenCalledWith('One moment... ');
  });
});
