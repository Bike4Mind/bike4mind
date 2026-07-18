import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';

const mockGet = vi.fn();
const mockPost = vi.fn();
vi.mock('../auth/ApiClient', () => ({
  ApiClient: class {
    get = mockGet;
    post = mockPost;
  },
}));

import { B4mApiClient, mapApiError } from './b4mApiClient';

const axiosError = (status: number, opts: { headers?: Record<string, string>; data?: unknown; code?: string } = {}) =>
  new AxiosError('request failed', opts.code, {} as InternalAxiosRequestConfig, {}, {
    status,
    statusText: '',
    data: opts.data ?? {},
    headers: opts.headers ?? {},
    config: {} as InternalAxiosRequestConfig,
  } as AxiosResponse);

describe('B4mApiClient', () => {
  let client: B4mApiClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new B4mApiClient('http://localhost:3000', undefined, 'b4m_live_key');
  });

  it('lists notebooks with search + pagination and normalizes the envelope', async () => {
    mockGet.mockResolvedValue({ data: [{ id: 'n1' }], hasMore: true });

    const result = await client.listNotebooks({ search: 'foo', limit: 10 });

    expect(mockGet).toHaveBeenCalledWith('/api/sessions', {
      params: { search: 'foo', pagination: { page: 1, limit: 10 } },
    });
    expect(result).toEqual({ data: [{ id: 'n1' }], hasMore: true });
  });

  it('normalizes a bare-array session response to { data, hasMore:false }', async () => {
    mockGet.mockResolvedValue([{ id: 'n1' }, { id: 'n2' }]);

    const result = await client.listNotebooks({ limit: 25 });

    expect(result).toEqual({ data: [{ id: 'n1' }, { id: 'n2' }], hasMore: false });
  });

  it('gets a notebook by id (url-encoded)', async () => {
    mockGet.mockResolvedValue({ id: 'n 1' });
    await client.getNotebook('n 1');
    expect(mockGet).toHaveBeenCalledWith('/api/sessions/n%201');
  });

  it('creates a notebook with only the provided fields', async () => {
    mockPost.mockResolvedValue({ id: 'n1' });
    await client.createNotebook({ name: 'My NB' });
    expect(mockPost).toHaveBeenCalledWith('/api/sessions/create', { name: 'My NB' });
  });

  it('sends a chat message with wait:true and maps notebookId to sessionId', async () => {
    mockPost.mockResolvedValue({ id: 'q1', status: 'complete' });
    await client.sendChat({ notebookId: 'nb1', message: 'hi', model: 'gpt' });
    expect(mockPost).toHaveBeenCalledWith('/api/chat', {
      sessionId: 'nb1',
      message: 'hi',
      model: 'gpt',
      wait: true,
    });
  });

  it('searches the knowledge base via semantic-search and returns scores', async () => {
    mockPost.mockResolvedValue({
      sessionIds: ['s1'],
      count: 1,
      scores: [{ sessionId: 's1', maxSimilarity: 0.9, matchingMessages: 2 }],
    });

    const result = await client.searchKnowledgeBase({ query: 'q', limit: 5, minSimilarity: 0.4 });

    expect(mockPost).toHaveBeenCalledWith('/api/sessions/semantic-search', {
      query: 'q',
      topK: 5,
      minSimilarity: 0.4,
    });
    expect(result).toEqual([{ sessionId: 's1', maxSimilarity: 0.9, matchingMessages: 2 }]);
  });

  it('lists files via /api/files/search', async () => {
    mockGet.mockResolvedValue({ data: [{ id: 'f1' }], hasMore: false });
    await client.listFiles({ search: 'doc', limit: 25 });
    expect(mockGet).toHaveBeenCalledWith('/api/files/search', {
      params: { search: 'doc', pagination: { page: 1, limit: 25 } },
    });
  });

  it('gets a file by id', async () => {
    mockGet.mockResolvedValue({ id: 'f1' });
    await client.getFile('f1');
    expect(mockGet).toHaveBeenCalledWith('/api/files/f1');
  });
});

describe('mapApiError', () => {
  it('maps 401 to a re-auth hint', () => {
    expect(mapApiError(axiosError(401), 'http://x')).toContain('authentication failed');
  });

  it('gives a broad forbidden message on 403 with the recommended scope', () => {
    expect(mapApiError(axiosError(403), 'http://x', 'files:read')).toBe(
      "API key forbidden: check the key's scopes and account access (recommended scope: files:read)"
    );
  });

  it('surfaces a retry-after on 429', () => {
    const msg = mapApiError(axiosError(429, { headers: { 'retry-after': '30' } }), 'http://x');
    expect(msg).toContain('rate limit');
    expect(msg).toContain('30s');
  });

  it('maps ECONNREFUSED to an unreachable-endpoint message with the base URL', () => {
    expect(mapApiError(axiosError(0, { code: 'ECONNREFUSED' }), 'http://localhost:9')).toBe(
      'cannot reach Bike4Mind at http://localhost:9'
    );
  });

  it('surfaces a server error body message when present', () => {
    expect(mapApiError(axiosError(400, { data: { error: 'Query is required' } }), 'http://x')).toBe(
      'Query is required'
    );
  });

  it('falls back to the message for a non-axios error', () => {
    expect(mapApiError(new Error('boom'), 'http://x')).toBe('boom');
  });
});
