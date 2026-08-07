import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the opensearch SDK so the constructor never opens a real connection. The mock
// Client instance is shared so tests can program per-method reject/resolve behavior.
const mockClient = {
  index: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  deleteByQuery: vi.fn(),
  search: vi.fn(),
  indices: { create: vi.fn(), delete: vi.fn(), exists: vi.fn() },
  transport: { request: vi.fn() },
  close: vi.fn(),
};

let lastClientConstructorArgs: unknown;

vi.mock('@opensearch-project/opensearch', () => ({
  // Regular function (not arrow) so `new Client(...)` works as a constructor.
  Client: vi.fn(function MockClient(args: unknown) {
    lastClientConstructorArgs = args;
    return mockClient;
  }),
}));
vi.mock('@opensearch-project/opensearch/aws-v3', () => ({
  AwsSigv4Signer: vi.fn(() => ({})),
}));
vi.mock('@aws-sdk/credential-provider-node', () => ({
  defaultProvider: vi.fn(() => () => Promise.resolve({})),
}));

import { OpenSearchClient, isTransientOpenSearchError, getOpenSearchRetryAfterMs } from './opensearchClient';

/** Build an opensearch-js-style ResponseError carrying an HTTP status code. */
function responseError(statusCode: number, message = `status ${statusCode}`): Error {
  const err = new Error(message) as Error & { statusCode: number };
  err.name = 'ResponseError';
  err.statusCode = statusCode;
  return err;
}

/** Build a named connection-level error (ConnectionError, TimeoutError, ...). */
function namedError(name: string, message = name): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

describe('isTransientOpenSearchError', () => {
  it.each([429, 502, 503, 504])('treats HTTP %i as transient', statusCode => {
    expect(isTransientOpenSearchError(responseError(statusCode))).toBe(true);
  });

  it.each([400, 401, 403, 404, 409])('treats HTTP %i as non-transient', statusCode => {
    expect(isTransientOpenSearchError(responseError(statusCode))).toBe(false);
  });

  it.each(['ConnectionError', 'TimeoutError', 'NoLivingConnectionsError'])(
    'treats connection-level error "%s" as transient',
    name => {
      expect(isTransientOpenSearchError(namedError(name))).toBe(true);
    }
  );

  it('treats a circuit_breaking_exception message as transient even without a status code', () => {
    expect(isTransientOpenSearchError(new Error('[circuit_breaking_exception] parent breaker tripped'))).toBe(true);
  });

  it('does not retry an intentional RequestAbortedError', () => {
    expect(isTransientOpenSearchError(namedError('RequestAbortedError'))).toBe(false);
  });

  it('does not retry an arbitrary application error', () => {
    expect(isTransientOpenSearchError(new Error('mapper_parsing_exception'))).toBe(false);
  });
});

describe('getOpenSearchRetryAfterMs', () => {
  it('reads numeric Retry-After seconds from error.headers', () => {
    const err = Object.assign(new Error('429'), { headers: { 'retry-after': '2' } });
    expect(getOpenSearchRetryAfterMs(err)).toBe(2000);
  });

  it('falls back to error.meta.headers when top-level headers are absent', () => {
    const err = Object.assign(new Error('429'), { meta: { headers: { 'retry-after': '3' } } });
    expect(getOpenSearchRetryAfterMs(err)).toBe(3000);
  });

  it('parses an HTTP-date Retry-After into a non-negative delay', () => {
    const future = new Date(Date.now() + 5000).toUTCString();
    const err = Object.assign(new Error('429'), { headers: { 'retry-after': future } });
    const ms = getOpenSearchRetryAfterMs(err);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(5000);
  });

  it('returns null when there is no Retry-After header', () => {
    expect(getOpenSearchRetryAfterMs(new Error('429'))).toBeNull();
    expect(getOpenSearchRetryAfterMs(Object.assign(new Error('429'), { headers: {} }))).toBeNull();
  });
});

describe('OpenSearchClient retry/backoff', () => {
  let client: OpenSearchClient;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    client = new OpenSearchClient('search.example.com');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries a write after transient 429 then 503 and eventually succeeds', async () => {
    mockClient.index
      .mockRejectedValueOnce(responseError(429, 'circuit_breaking_exception'))
      .mockRejectedValueOnce(responseError(503))
      .mockResolvedValueOnce({ statusCode: 200 });

    const promise = client.indexDocument('idx', { id: 'doc-1' });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBeUndefined();
    expect(mockClient.index).toHaveBeenCalledTimes(3);
  });

  it('does not retry a non-transient 400 and surfaces the error on the first attempt', async () => {
    mockClient.update.mockRejectedValue(responseError(400, 'mapper_parsing_exception'));

    const promise = client.updateDocument('idx', { id: 'doc-2' });
    const assertion = expect(promise).rejects.toThrow('mapper_parsing_exception');
    await vi.runAllTimersAsync();
    await assertion;
    expect(mockClient.update).toHaveBeenCalledTimes(1);
  });

  it('gives up after exhausting retries on persistent transient errors', async () => {
    mockClient.delete.mockRejectedValue(responseError(503));

    const promise = client.deleteDocument('idx', 'doc-3');
    const assertion = expect(promise).rejects.toThrow('status 503');
    await vi.runAllTimersAsync();
    await assertion;
    // 1 initial attempt + 5 retries (OPENSEARCH_RETRY_MAX_RETRIES) = 6 calls.
    expect(mockClient.delete).toHaveBeenCalledTimes(6);
  });

  it('retries upserts on a connection-level error', async () => {
    mockClient.update
      .mockRejectedValueOnce(namedError('ConnectionError', 'No living connections'))
      .mockResolvedValueOnce({ statusCode: 200 });

    const promise = client.upsertDocument('idx', { id: 'doc-4' });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBeUndefined();
    expect(mockClient.update).toHaveBeenCalledTimes(2);
  });

  it('retries indexExists on a transient error and returns the resolved body', async () => {
    mockClient.indices.exists.mockRejectedValueOnce(responseError(503)).mockResolvedValueOnce({ body: true });

    const promise = client.indexExists('idx');
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe(true);
    expect(mockClient.indices.exists).toHaveBeenCalledTimes(2);
  });

  it('createIndex merges caller-provided settings with the baseline knn:true', async () => {
    mockClient.indices.create.mockResolvedValueOnce({ statusCode: 200 });

    await client.createIndex('idx', {
      mappings: { properties: { vector: { type: 'knn_vector' } } },
      settings: { 'index.knn.algo_param.ef_search': 100 },
    });

    expect(mockClient.indices.create).toHaveBeenCalledWith({
      index: 'idx',
      body: {
        settings: { knn: true, 'index.knn.algo_param.ef_search': 100 },
        mappings: { properties: { vector: { type: 'knn_vector' } } },
      },
    });
  });

  it('knnQuery runs a plain knn search and maps hits when no filter is given', async () => {
    mockClient.search.mockResolvedValueOnce({
      body: { hits: { hits: [{ _id: 'chunk-1', _score: 0.9, _source: { text: 'hello' } }] } },
    });

    const results = await client.knnQuery('idx', [0.1, 0.2], 5);

    expect(mockClient.search).toHaveBeenCalledWith({
      index: 'idx',
      body: { size: 5, query: { knn: { vector: { vector: [0.1, 0.2], k: 5 } } } },
    });
    expect(results).toEqual([{ id: 'chunk-1', score: 0.9, source: { text: 'hello' } }]);
  });

  it('knnQuery wraps the knn clause in a bool filter when a filter is given', async () => {
    mockClient.search.mockResolvedValueOnce({ body: { hits: { hits: [] } } });
    const filter = { terms: { fabFileId: ['f1', 'f2'] } };

    await client.knnQuery('idx', [0.1, 0.2], 5, filter);

    expect(mockClient.search).toHaveBeenCalledWith({
      index: 'idx',
      body: {
        size: 5,
        query: { bool: { must: [{ knn: { vector: { vector: [0.1, 0.2], k: 5 } } }], filter: [filter] } },
      },
    });
  });

  it('knnQuery retries on a transient error', async () => {
    mockClient.search.mockRejectedValueOnce(responseError(503)).mockResolvedValueOnce({ body: { hits: { hits: [] } } });

    const promise = client.knnQuery('idx', [0.1], 1);
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toEqual([]);
    expect(mockClient.search).toHaveBeenCalledTimes(2);
  });
});

describe('OpenSearchClient self-host construction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('the default constructor signs requests with AWS SigV4 over https', async () => {
    const { AwsSigv4Signer } = await import('@opensearch-project/opensearch/aws-v3');
    new OpenSearchClient('search.example.com');

    expect(AwsSigv4Signer).toHaveBeenCalled();
    expect(lastClientConstructorArgs).toMatchObject({ node: 'https://search.example.com' });
  });

  it('selfHosted skips AWS SigV4 and connects over plain http', async () => {
    const { AwsSigv4Signer } = await import('@opensearch-project/opensearch/aws-v3');
    new OpenSearchClient('localhost:9200', { selfHosted: true });

    expect(AwsSigv4Signer).not.toHaveBeenCalled();
    expect(lastClientConstructorArgs).toMatchObject({ node: 'http://localhost:9200' });
  });
});
