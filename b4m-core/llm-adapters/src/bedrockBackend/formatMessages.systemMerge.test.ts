import { describe, expect, it } from 'vitest';
import type { IMessage, MessageContentText } from '@bike4mind/common';
import AnthropicBedrockBackend from './anthropic';

/**
 * Regression: `formatMessages` merges consecutive same-role messages, and its array branch used to
 * bail out with `return cur` whenever the accumulated content already held a text block - which is
 * true for every message after the second. A run of N same-role messages therefore collapsed to the
 * FIRST TWO and the rest vanished silently, with no error and no log.
 *
 * System messages are all consecutive at the head of the prompt, so on Bedrock only the date and the
 * artifact prompt survived: the help-center prompt, tool guidance, knowledge retrieval, session/org
 * prompts and BOTH Mementos versions were dropped. Memory could never reach a Bedrock Claude - the
 * default chat model. These tests pin the accumulate-don't-discard behavior.
 */
const sys = (text: string): IMessage => ({ role: 'system', content: text }) as IMessage;
const textOf = (m: IMessage): string[] =>
  Array.isArray(m.content)
    ? (m.content as MessageContentText[]).filter(c => c.type === 'text').map(c => c.text)
    : [m.content as string];

describe('AnthropicBedrockBackend.formatMessages - consecutive same-role merge', () => {
  const backend = new AnthropicBedrockBackend();

  it('keeps EVERY system message, not just the first two', () => {
    const messages = [
      sys('Current date: Sunday, July 12, 2026'),
      sys('ARTIFACT OUTPUT: ...'),
      sys('HELP CENTER: ...'),
      sys('[Memory] User favorite color is green'),
      sys('[Memory] User works in quantum computing'),
    ];

    const out = backend.formatMessages(messages);

    expect(out).toHaveLength(1); // merged into one system message...
    const texts = textOf(out[0]);
    expect(texts).toHaveLength(5); // ...carrying all five blocks
    expect(texts).toEqual([
      'Current date: Sunday, July 12, 2026',
      'ARTIFACT OUTPUT: ...',
      'HELP CENTER: ...',
      '[Memory] User favorite color is green',
      '[Memory] User works in quantum computing',
    ]);
  });

  it('carries injected memory through to the merged system content', () => {
    const out = backend.formatMessages([sys('date'), sys('artifact'), sys('[Memory] User favorite color is green')]);

    expect(textOf(out[0]).join('\n')).toContain('[Memory] User favorite color is green');
  });

  it('still de-dupes an exactly repeated message', () => {
    const out = backend.formatMessages([sys('same'), sys('same'), sys('other')]);
    expect(textOf(out[0])).toEqual(['same', 'other']);
  });

  it('does not merge across different roles', () => {
    const out = backend.formatMessages([
      sys('a'),
      sys('b'),
      sys('c'),
      { role: 'user', content: 'hello' } as IMessage,
      { role: 'assistant', content: 'hi' } as IMessage,
    ]);

    expect(out.map(m => m.role)).toEqual(['system', 'user', 'assistant']);
    expect(textOf(out[0])).toEqual(['a', 'b', 'c']);
  });

  it('merges a long run without dropping the tail', () => {
    const many = Array.from({ length: 14 }, (_, i) => sys(`block-${i}`));
    const out = backend.formatMessages(many);
    expect(textOf(out[0])).toHaveLength(14);
    expect(textOf(out[0])[13]).toBe('block-13');
  });
});
