import { describe, it, expect, vi, afterEach } from 'vitest';
import { Logger } from '@bike4mind/observability';
import { BaseBedrockBackend } from './base';
import type { ICompletionOptions, ICompletionResponseChunk, IMessage, ModelInfo } from '@bike4mind/common';
import { ChatModels } from '@bike4mind/common';
import { ChoiceEndReason, ChoiceStatus, type ICompletionOptionTools } from '../backend';

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
  /** One body per complete() turn, in call order. The last entry is reused for further turns. */
  payloadBodies: string[] = [BODY];

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
    const next = this.payloadBodies.length > 1 ? this.payloadBodies.shift() : undefined;
    const body = next ?? this.payloadBodies[0];
    return { modelId: 'test', contentType: 'application/json', accept: 'application/json', body };
  }
  translateStreamChunk(): { done: boolean; chunk?: ICompletionResponseChunk } {
    return { done: true };
  }
  translateChunk(_model: string, json: unknown): { done: boolean; chunk?: ICompletionResponseChunk } {
    return { done: false, chunk: json as ICompletionResponseChunk };
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
    $retryable: true,
    $metadata: { httpStatusCode: 503, requestId: 'req-1' },
  });

const searchTool: ICompletionOptionTools = {
  toolSchema: { name: 'search', description: 'x', parameters: { type: 'object', properties: {} } },
  toolFn: async () => 'tool output',
};

const toolCallChunk = () => ({
  choices: [
    {
      index: 0,
      status: ChoiceStatus.END,
      statusEndReason: ChoiceEndReason.TOOL_USE,
      tool: { name: 'search', id: 'tool_1', parameters: '{}' },
      usage: { input_tokens: 10, output_tokens: 2 },
    },
  ],
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
    expect(logged).toContain('unable to process');
    expect(logged).toContain('"$fault":"server"');
    expect(logged).toContain('"$retryable":true');
    expect(logged).toContain('"messageCount":3');
    for (const secret of [SECRET_PROMPT, SECRET_REPLY, SECRET_SYSTEM, 'docs.example.com', 'venue']) {
      expect(logged).not.toContain(secret);
    }
  });

  it('logs a failure once even when it rethrows through a nested tool-use turn', async () => {
    const errorSpy = vi.spyOn(Logger.globalInstance, 'error').mockImplementation(() => undefined);
    let callIndex = 0;
    const backend = new TestBedrockBackend();
    // The outer turn sends a single message; the nested turn after the tool result sends three.
    // Only the nested body can produce the shape asserted below.
    backend.payloadBodies = [
      JSON.stringify({ messages: [{ role: 'user', content: SECRET_PROMPT }] }),
      BODY,
    ];
    (backend as unknown as { _bedrockRuntime: { send: () => Promise<unknown> } })._bedrockRuntime = {
      send: async () => {
        if (callIndex++ === 0) return { body: new TextEncoder().encode(JSON.stringify(toolCallChunk())) };
        throw serviceUnavailable();
      },
    };

    await expect(
      backend.complete(
        'test-model' as ChatModels,
        [{ role: 'user', content: SECRET_PROMPT }],
        { stream: false, tools: [searchTool], executeTools: true } as Partial<ICompletionOptions>,
        async () => {}
      )
    ).rejects.toThrow(/unable to process/);

    expect(callIndex).toBe(2);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    // The log describes the failing (innermost) request, not the outer turn that succeeded.
    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).toContain('"messageCount":3');
    expect(logged).toContain('"lastMessageBlocks":["tool_result"]');
  });
});
