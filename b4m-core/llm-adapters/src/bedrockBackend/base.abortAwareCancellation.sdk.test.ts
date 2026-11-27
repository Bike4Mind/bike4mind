import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { ChatModels, type IMessage } from '@bike4mind/common';
import { BaseBedrockBackend } from './base';
import { ConverseBedrockBackend } from './converse';
import { ChoiceEndReason, ChoiceStatus, type ICompletionResponseChunk } from '../backend';

type HttpResponse = { statusCode: number; headers: Record<string, string>; body: Uint8Array | PassThrough };

class SdkHarness {
  readonly transport = {
    handle:
      vi.fn<(_request: unknown, options?: { abortSignal?: AbortSignal }) => Promise<{ response: HttpResponse }>>(),
    destroy: vi.fn(),
    metadata: { handlerProtocol: 'h2' },
  };
  client?: BedrockRuntimeClient;

  injectTransport(client: BedrockRuntimeClient): BedrockRuntimeClient {
    this.client = client;
    Object.assign(client.config, {
      requestHandler: this.transport,
      credentials: async () => ({ accessKeyId: 'synthetic-key', secretAccessKey: 'synthetic-secret' }),
    });
    return client;
  }
}

class InvokeSdkBackend extends BaseBedrockBackend {
  readonly harness = new SdkHarness();
  protected override createAbortAwareClient(model: string): BedrockRuntimeClient {
    return this.harness.injectTransport(super.createAbortAwareClient(model));
  }
  formatMessages = (messages: IMessage[]) => messages;
  getPayload = () => ({ modelId: 'synthetic-model', contentType: 'application/json', accept: '*/*', body: '{}' });
  translateChunk = (_model: string, chunk: unknown) => ({ done: true, chunk: chunk as ICompletionResponseChunk });
  translateStreamChunk = this.translateChunk;
  pushToolMessages = () => undefined;
  getModelInfo = async () => [];
}

class ConverseSdkBackend extends ConverseBedrockBackend {
  readonly harness = new SdkHarness();
  protected override createAbortAwareClient(model: string): BedrockRuntimeClient {
    return this.harness.injectTransport(super.createAbortAwareClient(model));
  }
}

const model = ChatModels.NOVA_PRO_BEDROCK;
const messages: IMessage[] = [{ role: 'user', content: 'hello' }];
const families = [
  {
    name: 'Invoke',
    create: () => new InvokeSdkBackend(),
    payload: {
      model,
      choices: [
        {
          index: 0,
          status: ChoiceStatus.END,
          statusEndReason: ChoiceEndReason.STOP,
          chunkText: 'complete',
          usage: { input_tokens: 9, output_tokens: 2 },
        },
      ],
    },
  },
  {
    name: 'Converse',
    create: () => new ConverseSdkBackend(),
    payload: {
      output: { message: { content: [{ text: 'complete' }] } },
      stopReason: 'end_turn',
      usage: { inputTokens: 9, outputTokens: 2 },
    },
  },
];

function success(payload: unknown): { response: HttpResponse } {
  return {
    response: {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify(payload)),
    },
  };
}

function unavailable(retryAfter: Record<string, string>): { response: HttpResponse } {
  return {
    response: {
      statusCode: 503,
      headers: { 'content-type': 'application/json', 'x-amzn-errortype': 'ServiceUnavailableException', ...retryAfter },
      body: Buffer.from(JSON.stringify({ message: 'temporarily unavailable' })),
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe.each(families)('$name with the real SDK and an injected transport', ({ create, payload }) => {
  it('uses repository retries after a single SDK attempt and aborts a long Retry-After wait', async () => {
    const backend = create();
    const controller = new AbortController();
    const timers = vi.spyOn(globalThis, 'setTimeout');
    backend.harness.transport.handle.mockResolvedValue(unavailable({ 'retry-after': '60' }));
    const completion = backend.complete(
      model,
      messages,
      { stream: false, retryMode: 'abort-aware', abortSignal: controller.signal },
      async () => {}
    );
    const rejected = expect(completion).rejects.toMatchObject({ name: 'AbortError' });

    await vi.waitFor(() => expect(timers.mock.calls.some(([, delay]) => (delay ?? 0) > 59_000)).toBe(true));
    expect(backend.harness.transport.handle).toHaveBeenCalledOnce();
    expect(backend.harness.transport.handle.mock.calls[0][1]?.abortSignal).toBe(controller.signal);
    expect(await backend.harness.client?.config.maxAttempts()).toBe(1);
    expect(await backend.harness.client?.config.retryStrategy()).toMatchObject({ mode: 'standard' });
    controller.abort();
    await rejected;
    expect(backend.harness.transport.handle).toHaveBeenCalledOnce();
    expect(backend.harness.transport.destroy).toHaveBeenCalledOnce();
  });

  it('retries a real SDK service error to a genuine successful reply without adaptive admission', async () => {
    const backend = create();
    const controller = new AbortController();
    backend.harness.transport.handle
      .mockResolvedValueOnce(unavailable({ 'retry-after-ms': '1' }))
      .mockResolvedValueOnce(success(payload));
    const callback = vi.fn(async () => {});
    await backend.complete(
      model,
      messages,
      { stream: false, retryMode: 'abort-aware', abortSignal: controller.signal },
      callback
    );
    expect(backend.harness.transport.handle).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenCalledExactlyOnceWith(
      ['complete'],
      expect.objectContaining({ inputTokens: 9, outputTokens: 2 })
    );
    expect(backend.harness.transport.destroy).toHaveBeenCalledOnce();
  });

  it('keeps the SDK promise pending until a cancelled response body actually settles', async () => {
    const backend = create();
    const controller = new AbortController();
    const body = new PassThrough();
    backend.harness.transport.handle.mockResolvedValue({
      response: { statusCode: 200, headers: { 'content-type': 'application/json' }, body },
    });
    const callback = vi.fn(async () => {});
    const completion = backend.complete(
      model,
      messages,
      { stream: false, retryMode: 'abort-aware', abortSignal: controller.signal },
      callback
    );
    let settled = false;
    void completion.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    const rejected = expect(completion).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(backend.harness.transport.handle).toHaveBeenCalledOnce());
    controller.abort();
    await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(backend.harness.transport.destroy).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();

    body.end(JSON.stringify(payload));
    await rejected;
    expect(callback).toHaveBeenCalledExactlyOnceWith([], expect.objectContaining({ inputTokens: 9, outputTokens: 2 }));
    expect(backend.harness.transport.destroy).toHaveBeenCalledOnce();
    expect(backend.harness.transport.handle).toHaveBeenCalledOnce();
  });
});
