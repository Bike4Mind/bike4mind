import { describe, it, expect, vi, afterEach } from 'vitest';
import { Logger } from '@bike4mind/observability';
import { BaseBedrockBackend } from './base';
import { describePayloadShape } from './payloadShape';
import type { ICompletionOptions, ICompletionResponseChunk, IMessage, ModelInfo } from '@bike4mind/common';
import { ChatModels } from '@bike4mind/common';

/**
 * Bedrock error logs are forwarded to a shared alert channel, so a failed request must be logged by
 * shape only. These pin that no prompt, reply or system text reaches any error log entry, and that the
 * real error still does.
 */

const SECRET_PROMPT = 'please update the sheet at https://docs.example.com/d/abc123 and remove the venue booking';
const SECRET_REPLY = 'I cannot edit that sheet from here yet';
const SECRET_SYSTEM = 'internal system instructions';

const BODY = JSON.stringify({
  anthropic_version: 'bedrock-2023-05-31',
  max_tokens: 128000,
  system: SECRET_SYSTEM,
  thinking: { type: 'adaptive' },
  tools: [{ name: 'search', description: 'x', input_schema: {} }],
  messages: [
    { role: 'user', content: SECRET_PROMPT },
    { role: 'assistant', content: [{ type: 'text', text: SECRET_REPLY }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: SECRET_PROMPT }] },
  ],
});

class TestBedrockBackend extends BaseBedrockBackend {
  protected override updateClientForModel(): void {
    // keep the test-injected _bedrockRuntime mock
  }
  async getModelInfo(): Promise<ModelInfo[]> {
    return [];
  }
  formatMessages(messages: IMessage[]): IMessage[] {
    return messages;
  }
  getPayload() {
    return { modelId: 'test', contentType: 'application/json', accept: 'application/json', body: BODY };
  }
  translateStreamChunk(): { done: boolean; chunk?: ICompletionResponseChunk } {
    return { done: true };
  }
  translateChunk(): { done: boolean; chunk?: ICompletionResponseChunk } {
    return { done: true };
  }
  pushToolMessages(): void {}
}

const failingBackend = (error: Error): TestBedrockBackend => {
  const backend = new TestBedrockBackend();
  (backend as unknown as { _bedrockRuntime: { send: () => Promise<never> } })._bedrockRuntime = {
    send: async () => {
      throw error;
    },
  };
  return backend;
};

const serviceUnavailable = () =>
  Object.assign(new Error('Bedrock is unable to process your request.'), {
    name: 'ServiceUnavailableException',
    $fault: 'server',
    $metadata: { httpStatusCode: 503, requestId: 'req-1' },
  });

describe('BaseBedrockBackend error log redaction', () => {
  afterEach(() => vi.restoreAllMocks());

  it('logs the failure once, with the real error and no prompt text', async () => {
    const errorSpy = vi.spyOn(Logger.globalInstance, 'error').mockImplementation(() => undefined);

    await expect(
      failingBackend(serviceUnavailable()).complete(
        'test-model' as ChatModels,
        [{ role: 'user', content: SECRET_PROMPT }],
        { stream: true } as Partial<ICompletionOptions>,
        async () => {}
      )
    ).rejects.toThrow(/unable to process/);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).toContain('ServiceUnavailableException');
    expect(logged).toContain('req-1');
    expect(logged).toContain('"messageCount":3');
    for (const secret of [SECRET_PROMPT, SECRET_REPLY, SECRET_SYSTEM, 'docs.example.com', 'venue']) {
      expect(logged).not.toContain(secret);
    }
  });
});

describe('describePayloadShape', () => {
  it('keeps structure and numeric config, drops every string value', () => {
    expect(describePayloadShape(BODY)).toEqual({
      bodyChars: BODY.length,
      parseable: true,
      fields: {
        anthropic_version: { chars: 'bedrock-2023-05-31'.length },
        max_tokens: 128000,
        system: { chars: SECRET_SYSTEM.length },
        thinking: { keys: ['type'] },
        tools: { items: 1 },
        messages: { items: 3 },
      },
      messageCount: 3,
      roles: 'user,assistant,user',
      lastMessageBlocks: ['tool_result'],
    });
  });

  it('describes a non-messages provider body (e.g. a single prompt string) without its text', () => {
    const body = JSON.stringify({ prompt: SECRET_PROMPT, max_gen_len: 512 });
    const shape = describePayloadShape(body);
    expect(shape.fields).toEqual({ prompt: { chars: SECRET_PROMPT.length }, max_gen_len: 512 });
    expect(JSON.stringify(shape)).not.toContain('venue');
  });

  it('reports only the size of an unparseable body', () => {
    expect(describePayloadShape(`not json ${SECRET_PROMPT}`)).toEqual({
      bodyChars: `not json ${SECRET_PROMPT}`.length,
      parseable: false,
    });
  });

  it('caps the role list to the tail of a long conversation', () => {
    const messages = Array.from({ length: 50 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x' }));
    const shape = describePayloadShape(JSON.stringify({ messages }));
    expect(shape.messageCount).toBe(50);
    expect(shape.roles?.split(',')).toHaveLength(41);
    expect(shape.roles?.startsWith('...,')).toBe(true);
  });
});
