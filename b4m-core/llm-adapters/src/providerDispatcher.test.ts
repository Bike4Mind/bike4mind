import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicBackend } from './anthropicBackend';
import { OpenAIBackend } from './openaiBackend';
import { providerDispatcher } from './providerDispatcher';

vi.mock('@aws-sdk/client-cloudwatch', () => ({
  CloudWatchClient: class {
    send = async () => ({});
  },
  PutMetricDataCommand: class {},
  StandardUnit: { Count: 'Count' },
}));

const json = () =>
  new Response(JSON.stringify({ id: 'x', object: 'list', data: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('providerDispatcher', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the same Agent on every call', () => {
    expect(providerDispatcher()).toBe(providerDispatcher());
  });

  it('AnthropicBackend passes the dispatcher to fetch', async () => {
    const fetchMock = vi.fn(async () => json());
    vi.stubGlobal('fetch', fetchMock);
    const backend = new AnthropicBackend('sk-ant-test');
    await (backend as unknown as { _api: { models: { list: () => Promise<unknown> } } })._api.models.list();
    const init = (fetchMock.mock.calls[0] as unknown[])[1] as { dispatcher?: unknown };
    expect(init.dispatcher).toBe(providerDispatcher());
  });

  it('OpenAIBackend passes the dispatcher to fetch', async () => {
    const fetchMock = vi.fn(async () => json());
    vi.stubGlobal('fetch', fetchMock);
    const backend = new OpenAIBackend('sk-test');
    await (backend as unknown as { _api: { models: { list: () => Promise<unknown> } } })._api.models.list();
    const init = (fetchMock.mock.calls[0] as unknown[])[1] as { dispatcher?: unknown };
    expect(init.dispatcher).toBe(providerDispatcher());
  });
});
