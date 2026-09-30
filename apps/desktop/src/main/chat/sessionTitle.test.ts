import type { ChatModelOption } from '@shared/chat';
import { describe, expect, it } from 'vitest';
import { pickTitleModel, sanitizeGeneratedTitle, titleRequestMessages, TITLE_MODELS } from './sessionTitle';

const option = (id: string): ChatModelOption => ({ id, name: id });

describe('pickTitleModel', () => {
  it('prefers a small model over the one the conversation is held on', () => {
    const available = [option('claude-opus-4-5-20251101'), option(TITLE_MODELS[0])];
    expect(pickTitleModel(available, 'claude-opus-4-5-20251101')).toBe(TITLE_MODELS[0]);
  });

  it('follows the preference order when the server offers several', () => {
    const available = [option(TITLE_MODELS[2]), option(TITLE_MODELS[0])];
    expect(pickTitleModel(available, 'anything')).toBe(TITLE_MODELS[0]);
  });

  // A self-host stack with one big model still gets readable titles; it just pays that model.
  it('falls back to the session model when the server offers none of them', () => {
    expect(pickTitleModel([option('qwen3.5')], 'qwen3.5')).toBe('qwen3.5');
  });

  // An unreadable catalog says nothing about what the server has, and the session's own model
  // could be the most expensive thing on it.
  it('declines outright when the catalog is empty', () => {
    expect(pickTitleModel([], 'claude-opus-4-5-20251101')).toBeNull();
  });
});

describe('titleRequestMessages', () => {
  it('sends the instruction and the prompt, and nothing else', () => {
    const messages = titleRequestMessages('how do I debug this websocket?');
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
    expect(messages[1].content).toContain('how do I debug this websocket?');
    expect(String(messages[1].content)).toMatch(/^Name this message:/);
  });

  it('sends an excerpt of a long paste rather than the whole thing', () => {
    const messages = titleRequestMessages('x'.repeat(50_000));
    expect(String(messages[1].content).length).toBeLessThan(2000);
  });
});

describe('sanitizeGeneratedTitle', () => {
  it('keeps a well-formed title as written', () => {
    expect(sanitizeGeneratedTitle('Debugging a websocket handshake')).toBe('Debugging a websocket handshake');
  });

  it('strips the quotes and markdown a model wraps a title in', () => {
    expect(sanitizeGeneratedTitle('**"Debugging a websocket"**')).toBe('Debugging a websocket');
  });

  it('drops trailing punctuation', () => {
    expect(sanitizeGeneratedTitle('Debugging a websocket.')).toBe('Debugging a websocket');
  });

  // The whole point of the row is that it is one line; a newline would break the column.
  it('collapses a multi-line reply onto one line', () => {
    expect(sanitizeGeneratedTitle('Debugging\n\na websocket')).toBe('Debugging a websocket');
  });

  it('removes control bytes rather than writing them to the session file', () => {
    expect(sanitizeGeneratedTitle('Debug\u0007ging\u0000 sockets')).toBe('Debug ging sockets');
  });

  it('cuts an overlong title at a word boundary, with no ellipsis', () => {
    const title = sanitizeGeneratedTitle('Debugging a websocket handshake that fails on reconnect in production');
    expect(title).toBe('Debugging a websocket handshake that fails on');
  });

  it.each([
    ['blank', '   \n  '],
    ['decoration only', '***'],
    // The model answered the prompt instead of naming it. Cutting this to length would read as
    // a confident sentence fragment, which is worse than the truncation it would replace.
    [
      'an answer rather than a title',
      `I'd be happy to help with that. ${'The first step is to check the logs. '.repeat(4)}`,
    ],
  ])('refuses %s, so the caller keeps the truncation', (_label, reply) => {
    expect(sanitizeGeneratedTitle(reply)).toBeNull();
  });
});
