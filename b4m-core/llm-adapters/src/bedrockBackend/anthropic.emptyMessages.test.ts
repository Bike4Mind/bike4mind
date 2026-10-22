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

  it('continues to preserve a valid non-empty conversation', () => {
    const body = JSON.parse(payload([{ role: 'user', content: 'hello' }]).body) as { messages: IMessage[] };
    expect(body.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });
});
