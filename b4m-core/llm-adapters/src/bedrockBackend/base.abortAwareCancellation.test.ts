import { afterEach, describe, expect, it, vi } from 'vitest';
import { BedrockRuntimeClient, ConverseCommand, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { ChatModels, type IMessage } from '@bike4mind/common';
import { BaseBedrockBackend } from './base';
import { ConverseBedrockBackend } from './converse';
import { ChoiceEndReason, ChoiceStatus, type ICompletionResponseChunk } from '../backend';

const model = ChatModels.NOVA_PRO_BEDROCK;
const messages: IMessage[] = [{ role: 'user', content: 'hello' }];
const usage = { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 5, cache_creation_input_tokens: 3 };

function rawResponse(withUsage = true) {
  return {
    body: new TextEncoder().encode(
      JSON.stringify({
        model,
        choices: [
          {
            index: 0,
            status: ChoiceStatus.END,
            statusEndReason: ChoiceEndReason.STOP,
            chunkText: 'completed',
            ...(withUsage ? { usage } : {}),
          },
        ],
      })
    ),
  };
}

function converseResponse(withUsage = true) {
  return {
    output: { message: { content: [{ text: 'completed' }] } },
    stopReason: 'end_turn',
    ...(withUsage
      ? { usage: { inputTokens: 12, outputTokens: 4, cacheReadInputTokens: 5, cacheWriteInputTokens: 3 } }
      : {}),
  };
}

class ClientHarness {
  readonly send = vi.fn<(...args: unknown[]) => Promise<unknown>>();
  readonly destroy = vi.fn();
  readonly clients: BedrockRuntimeClient[] = [];

  inject(client: BedrockRuntimeClient): BedrockRuntimeClient {
    this.clients.push(client);
    return Object.assign(client, { send: this.send, destroy: this.destroy });
  }
}

class InvokeBackend extends BaseBedrockBackend {
  readonly harness = new ClientHarness();
  readonly initialClient = this._bedrockRuntime;
  protected override updateClientForModel(model: string): void {
    super.updateClientForModel(model);
    this.harness.inject(this._bedrockRuntime);
  }
  protected override createAbortAwareClient(model: string): BedrockRuntimeClient {
    return this.harness.inject(super.createAbortAwareClient(model));
  }
  formatMessages = (messages: IMessage[]) => messages;
  getPayload = () => ({ modelId: 'synthetic-model', contentType: 'application/json', accept: '*/*', body: '{}' });
  translateChunk = (_model: string, chunk: unknown) => ({ done: true, chunk: chunk as ICompletionResponseChunk });
  translateStreamChunk = this.translateChunk;
  pushToolMessages = () => undefined;
  getModelInfo = async () => [];
}

class ConverseBackend extends ConverseBedrockBackend {
  readonly harness = new ClientHarness();
  readonly initialClient = this._bedrockRuntime;
  protected override updateClientForModel(model: string): void {
    super.updateClientForModel(model);
    this.harness.inject(this._bedrockRuntime);
  }
  protected override createAbortAwareClient(model: string): BedrockRuntimeClient {
    return this.harness.inject(super.createAbortAwareClient(model));
  }
}

afterEach(() => vi.restoreAllMocks());

describe.each([
  { name: 'Invoke', create: () => new InvokeBackend(), response: rawResponse, command: InvokeModelCommand },
  { name: 'Converse', create: () => new ConverseBackend(), response: converseResponse, command: ConverseCommand },
])('$name abort-aware cancellation', ({ create, response, command }) => {
  it('uses a per-call single-attempt standard client and forwards the original signal', async () => {
    const backend = create();
    const controller = new AbortController();
    const legacyDestroy = vi.spyOn(backend.initialClient.config.requestHandler, 'destroy');
    backend.harness.send.mockResolvedValue(response());
    const callback = vi.fn(async () => {});

    await backend.complete(
      model,
      messages,
      {
        stream: false,
        retryMode: 'abort-aware',
        abortSignal: controller.signal,
        cacheStrategy: { enableCaching: true },
      },
      callback
    );

    const [client] = backend.harness.clients;
    expect(await client.config.maxAttempts()).toBe(1);
    expect(await client.config.retryStrategy()).toMatchObject({ mode: 'standard' });
    expect(client.config.requestHandler).not.toBe(backend.initialClient.config.requestHandler);
    expect(legacyDestroy).not.toHaveBeenCalled();
    expect(await backend.initialClient.config.maxAttempts()).toBe(6);
    expect(await backend.initialClient.config.retryStrategy()).toMatchObject({ mode: 'adaptive' });
    expect(backend.harness.send).toHaveBeenCalledExactlyOnceWith(expect.any(command), {
      abortSignal: controller.signal,
    });
    expect(backend.harness.destroy).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenLastCalledWith(
      ['completed'],
      expect.objectContaining({
        inputTokens: 12,
        outputTokens: 4,
        cacheReadInputTokens: 5,
        cacheCreationInputTokens: 3,
        turnUsage: [{ inputTokens: 12, outputTokens: 4, cacheReadInputTokens: 5, cacheCreationInputTokens: 3 }],
        cacheStats: expect.objectContaining({
          totalInputTokens: 20,
          uncachedTokens: 12,
          cacheReadTokens: 5,
          cacheWriteTokens: 3,
          costSavingsPercent: 22.5,
        }),
      })
    );
  });

  it('preserves six-attempt adaptive clients for legacy calls', async () => {
    const backend = create();
    backend.harness.send.mockResolvedValue(response());
    await backend.complete(model, messages, { stream: false }, async () => {});
    const [client] = backend.harness.clients;
    expect(await client.config.maxAttempts()).toBe(6);
    expect(await client.config.retryStrategy()).toMatchObject({ mode: 'adaptive' });
    expect(backend.harness.destroy).not.toHaveBeenCalled();
  });

  it('rejects missing or pre-aborted signals before creating a request client', async () => {
    const backend = create();
    const controller = new AbortController();
    controller.abort();
    await expect(
      backend.complete(model, messages, { stream: false, retryMode: 'abort-aware' }, async () => {})
    ).rejects.toThrow(/abort signal/);
    await expect(
      backend.complete(
        model,
        messages,
        { stream: false, retryMode: 'abort-aware', abortSignal: controller.signal },
        async () => {}
      )
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(backend.harness.clients).toHaveLength(0);
    expect(backend.harness.send).not.toHaveBeenCalled();
  });

  it.each([
    { stream: true },
    { stream: false, tools: [{ toolSchema: { name: 'sample', description: 'sample' }, toolFn: vi.fn() }] },
    { stream: false, _internal: { evaluation: true } },
  ])('rejects unsupported opt-in calls before dispatch: %o', async options => {
    const backend = create();
    await expect(
      backend.complete(
        model,
        messages,
        { ...options, retryMode: 'abort-aware', abortSignal: new AbortController().signal },
        async () => {}
      )
    ).rejects.toThrow(/require a non-streaming/);
    expect(backend.harness.clients).toHaveLength(0);
    expect(backend.harness.send).not.toHaveBeenCalled();
  });

  it('aborts a Retry-After wait without another attempt', async () => {
    const backend = create();
    const controller = new AbortController();
    const timers = vi.spyOn(globalThis, 'setTimeout');
    backend.harness.send.mockRejectedValue(
      Object.assign(new Error('temporarily unavailable'), {
        name: 'ServiceUnavailableException',
        $metadata: { httpStatusCode: 503 },
        $response: { headers: { 'retry-after': '60' } },
      })
    );
    const completion = backend.complete(
      model,
      messages,
      { stream: false, retryMode: 'abort-aware', abortSignal: controller.signal },
      async () => {}
    );
    const rejected = expect(completion).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(timers.mock.calls.some(([, delay]) => (delay ?? 0) > 59_000)).toBe(true));
    controller.abort();
    await rejected;
    expect(backend.harness.send).toHaveBeenCalledOnce();
    expect(backend.harness.destroy).toHaveBeenCalledOnce();
  });

  it.each([true, false])('awaits actual late transport settlement before cancellation (usage=%s)', async withUsage => {
    const backend = create();
    const controller = new AbortController();
    const deferred = Promise.withResolvers<unknown>();
    backend.harness.send.mockReturnValue(deferred.promise);
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
    controller.abort();
    await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(backend.harness.destroy).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();

    deferred.resolve(response(withUsage));
    await rejected;
    expect(backend.harness.destroy).toHaveBeenCalledOnce();
    if (withUsage) {
      expect(callback).toHaveBeenCalledExactlyOnceWith(
        [],
        expect.objectContaining({
          inputTokens: 12,
          outputTokens: 4,
          cacheReadInputTokens: 5,
          cacheCreationInputTokens: 3,
        })
      );
    } else {
      expect(callback).not.toHaveBeenCalled();
    }
    expect(backend.harness.send).toHaveBeenCalledOnce();
  });

  it('preserves an actual transport abort error after deferred cleanup', async () => {
    const backend = create();
    const controller = new AbortController();
    const deferred = Promise.withResolvers<unknown>();
    const error = Object.assign(new Error('request aborted'), { name: 'AbortError' });
    backend.harness.send.mockReturnValue(deferred.promise);
    const callback = vi.fn(async () => {});
    const completion = backend.complete(
      model,
      messages,
      { stream: false, retryMode: 'abort-aware', abortSignal: controller.signal },
      callback
    );
    const rejected = expect(completion).rejects.toBe(error);
    controller.abort();
    await new Promise(resolve => setImmediate(resolve));
    expect(backend.harness.destroy).not.toHaveBeenCalled();
    deferred.reject(error);
    await rejected;
    expect(callback).not.toHaveBeenCalled();
    expect(backend.harness.destroy).toHaveBeenCalledOnce();
  });

  it.each([
    { name: 'TimeoutError', attempts: 3 },
    { name: 'ValidationException', attempts: 1 },
  ])('preserves the final $name error after $attempts attempts', async ({ name, attempts }) => {
    const backend = create();
    const error = Object.assign(new Error('synthetic failure'), {
      name,
      $response: { headers: { 'retry-after-ms': '1' } },
    });
    backend.harness.send.mockRejectedValue(error);
    const callback = vi.fn(async () => {});
    await expect(
      backend.complete(
        model,
        messages,
        { stream: false, retryMode: 'abort-aware', abortSignal: new AbortController().signal },
        callback
      )
    ).rejects.toBe(error);
    expect(backend.harness.send).toHaveBeenCalledTimes(attempts);
    expect(callback).not.toHaveBeenCalled();
    expect(backend.harness.destroy).toHaveBeenCalledOnce();
  });

  it('propagates cancellation during the final callback without reporting usage twice', async () => {
    const backend = create();
    const controller = new AbortController();
    const reason = new Error('completion cancelled');
    backend.harness.send.mockResolvedValue(response());
    const callback = vi.fn(async () => {
      controller.abort(reason);
    });
    await expect(
      backend.complete(
        model,
        messages,
        { stream: false, retryMode: 'abort-aware', abortSignal: controller.signal },
        callback
      )
    ).rejects.toBe(reason);
    expect(callback).toHaveBeenCalledExactlyOnceWith(
      ['completed'],
      expect.objectContaining({ inputTokens: 12, outputTokens: 4 })
    );
    expect(backend.harness.send).toHaveBeenCalledOnce();
    expect(backend.harness.destroy).toHaveBeenCalledOnce();
  });
});
