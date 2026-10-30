import { BadRequestError, ChatModels, type IMessage } from '@bike4mind/common';
import { describe, expect, it } from 'vitest';
import AnthropicBedrockBackend from './anthropic';

const ERROR_MESSAGE = 'request must contain at least one non-empty user or assistant message';
const backend = new AnthropicBedrockBackend();

function payload(messages: IMessage[]) {
  return backend.getPayload(ChatModels.CLAUDE_4_6_SONNET_BEDROCK, messages, { maxTokens: 1024 });
}

describe('AnthropicBedrockBackend empty effective messages', () => {
  it.each([
    ['system-only', [{ role: 'system', content: 'system prompt' }] as IMessage[]],
    ['blank string', [{ role: 'user', content: '  \n ' }] as IMessage[]],
    ['blank text block', [{ role: 'assistant', content: [{ type: 'text', text: '\t' }] }] as IMessage[]],
  ])('rejects %s before building a provider payload', (_label, messages) => {
    expect(() => payload(messages)).toThrow(
      expect.objectContaining<Partial<BadRequestError>>({ statusCode: 400, message: ERROR_MESSAGE })
    );
  });

  it('repairs a leading tool_result whose tool_use only appears later', () => {
    const toolUse = { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: {} };
    const toolResult = { type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' };
    const body = JSON.parse(
      payload([
        { role: 'user', content: [toolResult] },
        { role: 'assistant', content: [toolUse] },
        { role: 'user', content: [toolResult] },
      ] as IMessage[]).body
    ) as { messages: IMessage[] };

    expect(body.messages).toEqual([
      { role: 'user', content: '[Tool results removed during adjacency repair]' },
      { role: 'assistant', content: [toolUse] },
      { role: 'user', content: [toolResult] },
    ]);
  });

  it('keeps the text of a user message that also carries an orphaned tool_result', () => {
    const toolUse = { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: {} };
    const toolResult = { type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' };
    const body = JSON.parse(
      payload([
        { role: 'user', content: [{ type: 'text', text: 'keep me' }, toolResult] },
        { role: 'assistant', content: [toolUse] },
        { role: 'user', content: [toolResult] },
      ] as IMessage[]).body
    ) as { messages: IMessage[] };

    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'keep me' }] },
      { role: 'assistant', content: [toolUse] },
      { role: 'user', content: [toolResult] },
    ]);
  });

  it('drops an assistant message that only holds an in-flight tool_use at the end of history', () => {
    const body = JSON.parse(
      payload([
        { role: 'user', content: 'look it up' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'lookup', input: {} }] },
      ] as IMessage[]).body
    ) as { messages: IMessage[] };

    expect(body.messages).toEqual([{ role: 'user', content: 'look it up' }]);
  });

  it('continues to preserve a valid non-empty conversation', () => {
    const body = JSON.parse(payload([{ role: 'user', content: 'hello' }]).body) as { messages: IMessage[] };
    expect(body.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });
});
