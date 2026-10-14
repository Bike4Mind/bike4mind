import { afterEach, describe, expect, it, vi } from 'vitest';
import { RateLimitError } from '@anthropic-ai/sdk';
import { ChatModels } from '@bike4mind/common';
import { AnthropicBackend } from './anthropicBackend';

vi.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: class {
    send = async () => ({});
  },
  PutMetricDataCommand: class {},
  StandardUnit: { Count: 'Count' },
}));

const LIMIT_MESSAGE = 'This request would exceed your organization rate limit of 4,000 input tokens per minute';

function makeLogger() {
  return { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
}

type Fetch = (input: unknown, init?: unknown) => Promise<Response>;
const sdkFetch = (backend: AnthropicBackend) => (backend as unknown as { _api: { fetch: Fetch } })._api.fetch;

function limitResponse(status: number, type: string) {
  return new Response(JSON.stringify({ type: 'error', error: { type, message: LIMIT_MESSAGE } }), {
    status,
    headers: {
      'content-type': 'application/json',
      'anthropic-workspace-id': 'wrkspc_test',
      'retry-after': '12',
      'request-id': 'req_test',
      'anthropic-ratelimit-input-tokens-limit': '4000',
      'anthropic-ratelimit-input-tokens-remaining': '0',
      'set-cookie': 'session=secret',
      'x-api-key': 'sk-ant-should-never-appear',
    },
  });
}

describe('AnthropicBackend rate-limit logging', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('logs each 429 attempt with workspace, limit headers and Anthropic message, and leaves the body readable', async () => {
    const logger = makeLogger();
    const response = limitResponse(429, 'rate_limit_error');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    const backend = new AnthropicBackend('sk-ant-test', logger as never);

    const result = await sdkFetch(backend)('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': 'sk-ant-test' },
      body: JSON.stringify({ model: 'claude-test', messages: [{ role: 'user', content: 'private prompt' }] }),
    });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [, fields] = logger.warn.mock.calls[0];
    expect(fields).toMatchObject({
      status: 429,
      model: 'claude-test',
      errorType: 'rate_limit_error',
      anthropicMessage: LIMIT_MESSAGE,
      headers: {
        'anthropic-workspace-id': 'wrkspc_test',
        'retry-after': '12',
        'request-id': 'req_test',
        'anthropic-ratelimit-input-tokens-limit': '4000',
        'anthropic-ratelimit-input-tokens-remaining': '0',
      },
    });
    const logged = JSON.stringify(logger.warn.mock.calls);
    expect(logged).not.toContain('secret');
    expect(logged).not.toContain('sk-ant');
    expect(logged).not.toContain('private prompt');

    expect(result.bodyUsed).toBe(false);
    expect((await result.json()).error.message).toBe(LIMIT_MESSAGE);
  });

  it('logs 529 and stays silent for other statuses', async () => {
    const logger = makeLogger();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(limitResponse(529, 'overloaded_error'))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const backend = new AnthropicBackend('sk-ant-test', logger as never);

    await sdkFetch(backend)('https://api.anthropic.com/v1/messages', {});
    await sdkFetch(backend)('https://api.anthropic.com/v1/messages', {});

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][1]).toMatchObject({ status: 529, errorType: 'overloaded_error' });
  });

  it('keeps Anthropic message, request id and workspace in the final rate-limit log', async () => {
    const logger = makeLogger();
    const backend = new AnthropicBackend('sk-ant-test', logger as never);
    const error = new RateLimitError(
      429,
      { type: 'error', error: { type: 'rate_limit_error', message: LIMIT_MESSAGE } },
      LIMIT_MESSAGE,
      new Headers({ 'anthropic-workspace-id': 'wrkspc_test', 'retry-after': '7', 'request-id': 'req_final' })
    );
    (backend as unknown as { _api: unknown })._api = {
      messages: { create: async () => Promise.reject(error) },
    };

    await expect(
      backend.complete(ChatModels.CLAUDE_4_8_OPUS, [{ role: 'user', content: 'hi' }], { stream: true }, async () => {})
    ).rejects.toBe(error);

    const call = logger.error.mock.calls.find(c => String(c[0]).includes('Rate limit error after all retries'));
    expect(call).toBeDefined();
    expect(call![1]).toMatchObject({
      status: 429,
      errorType: 'rate_limit_error',
      headers: { 'anthropic-workspace-id': 'wrkspc_test', 'retry-after': '7' },
    });
    expect(call![1].anthropicMessage).toContain(LIMIT_MESSAGE);
    expect(call![1]).not.toHaveProperty('message');
  });
});
