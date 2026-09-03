import { describe, it, expect, vi } from 'vitest';
import type { IMessage } from '@bike4mind/common';
import { normalizeToolUseInputs, stripToolDependentMessages } from './toolPairingUtils';

describe('stripToolDependentMessages', () => {
  const imagePrompt: IMessage = {
    role: 'system',
    content: 'When the user requests an image, you MUST use the image_generation tool to create it.',
    requiresTool: 'image_generation',
  };

  it('drops a message that names a required tool', () => {
    expect(stripToolDependentMessages([imagePrompt])).toEqual([]);
  });

  it('keeps every message that names none, in order', () => {
    const kept: IMessage[] = [
      { role: 'system', content: 'Format replies as markdown.' },
      { role: 'user', content: 'draw me a picture of a cat' },
      { role: 'assistant', content: 'Sure.' },
    ];
    expect(stripToolDependentMessages([kept[0], imagePrompt, kept[1], kept[2]])).toEqual(kept);
  });

  it('leaves the caller its own array', () => {
    const input: IMessage[] = [imagePrompt];
    stripToolDependentMessages(input);
    expect(input).toHaveLength(1);
  });

  // An empty string is not a tool name, so it must not be read as "depends on a tool" - the falsy
  // check has to agree with that or a mis-set marker would silently drop a prompt.
  it('keeps a message whose marker is an empty string', () => {
    const odd: IMessage = { role: 'system', content: 'still wanted', requiresTool: '' };
    expect(stripToolDependentMessages([odd])).toEqual([odd]);
  });

  it('returns an empty array unchanged', () => {
    expect(stripToolDependentMessages([])).toEqual([]);
  });
});

describe('normalizeToolUseInputs', () => {
  // A zero-argument tool call stores `input: {}`, and Mongoose's default `minimize` deletes empty
  // objects on the read boundary. Anthropic then rejects the replayed block with
  // "messages.N.content.0.tool_use.input: Field required".
  const withoutInput = (): IMessage[] => [
    { role: 'user', content: 'what time is it?' },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'current_datetime' }],
    } as unknown as IMessage,
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Saturday' }] },
  ];

  it('restores an empty input on a tool_use block that lost it', () => {
    const [, assistant] = normalizeToolUseInputs(withoutInput());
    expect((assistant.content as Array<Record<string, unknown>>)[0]).toEqual({
      type: 'tool_use',
      id: 'toolu_1',
      name: 'current_datetime',
      input: {},
    });
  });

  it('leaves a populated input untouched', () => {
    const messages: IMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'web_search', input: { query: 'mortgage' } }],
      },
    ];

    const [assistant] = normalizeToolUseInputs(messages);
    expect((assistant.content as Array<Record<string, unknown>>)[0].input).toEqual({ query: 'mortgage' });
  });

  it('repairs a tool_use whose input arrived as a non-object', () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'x', input: null }] },
    ] as unknown as IMessage[];

    const [assistant] = normalizeToolUseInputs(messages);
    expect((assistant.content as Array<Record<string, unknown>>)[0].input).toEqual({});
  });

  it('returns the same array reference when nothing needs repair', () => {
    const messages: IMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ];

    expect(normalizeToolUseInputs(messages)).toBe(messages);
  });

  it('does not mutate the input messages', () => {
    const messages = withoutInput();
    normalizeToolUseInputs(messages);
    expect((messages[1].content as Array<Record<string, unknown>>)[0]).not.toHaveProperty('input');
  });

  it('warns once with the repair count', () => {
    const warn = vi.fn();
    normalizeToolUseInputs(withoutInput(), { warn });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('1 tool_use block(s)');
  });
});
