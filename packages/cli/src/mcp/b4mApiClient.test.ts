import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';

const mockGet = vi.fn();
const mockPost = vi.fn();
const mockAxiosPost = vi.fn();
vi.mock('../auth/ApiClient', () => ({
  ApiClient: class {
    get = mockGet;
    post = mockPost;
    getAxiosInstance = () => ({ post: mockAxiosPost });
  },
  // Mirrors the real class identity mapApiError keys on: the mocked module and the
  // code under test must share the same class, or `instanceof` would never match.
  NotAuthenticatedError: class NotAuthenticatedError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'NotAuthenticatedError';
    }
  },
}));

import { B4mApiClient, mapApiError } from './b4mApiClient';
import { NotAuthenticatedError } from '../auth/ApiClient';

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

  it('threads an explicit page through session pagination so hasMore is reachable', async () => {
    mockGet.mockResolvedValue({ data: [{ id: 'n3' }], hasMore: false });

    await client.listNotebooks({ limit: 10, page: 2 });

    expect(mockGet).toHaveBeenCalledWith('/api/sessions', {
      params: { pagination: { page: 2, limit: 10 } },
    });
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

  it('forwards dataLakeId on create only when set', async () => {
    mockPost.mockResolvedValue({ id: 'n1' });
    await client.createNotebook({ name: 'My NB', dataLakeId: 'lake-1' });
    expect(mockPost).toHaveBeenCalledWith('/api/sessions/create', { name: 'My NB', dataLakeId: 'lake-1' });
  });

  it('lists data lakes with flat limit/cursor params and maps next_cursor', async () => {
    mockGet.mockResolvedValue({ data: [{ id: 'l1', name: 'Lake', slug: 'lake' }], next_cursor: 'c2' });
    const result = await client.listDataLakes({ limit: 10, cursor: 'c1' });
    expect(mockGet).toHaveBeenCalledWith('/api/v1/data-lakes', { params: { limit: 10, cursor: 'c1' } });
    expect(result).toEqual({ data: [{ id: 'l1', name: 'Lake', slug: 'lake' }], nextCursor: 'c2' });
  });

  it('omits cursor when listing the first page of data lakes', async () => {
    mockGet.mockResolvedValue({ data: [], next_cursor: null });
    const result = await client.listDataLakes({ limit: 25 });
    expect(mockGet).toHaveBeenCalledWith('/api/v1/data-lakes', { params: { limit: 25 } });
    // toHaveBeenCalledWith treats `cursor: undefined` as absent; pin that the key is not sent at all.
    expect(mockGet.mock.calls[0][1].params).not.toHaveProperty('cursor');
    expect(result).toEqual({ data: [], nextCursor: null });
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

  it('starts a new conversation when no notebookId is supplied', async () => {
    mockPost.mockResolvedValue({ id: 'q1', status: 'complete', sessionId: 'fresh-nb' });
    await client.sendChat({ message: 'hi' });
    expect(mockPost).toHaveBeenCalledWith('/api/chat', {
      newConversation: true,
      message: 'hi',
      wait: true,
    });
  });

  it('forwards a supplied systemPrompt in the chat body', async () => {
    mockPost.mockResolvedValue({ id: 'q1', status: 'complete' });
    await client.sendChat({ notebookId: 'nb1', message: 'hi', systemPrompt: 'Reply only in haiku.' });
    expect(mockPost).toHaveBeenCalledWith('/api/chat', {
      sessionId: 'nb1',
      message: 'hi',
      systemPrompt: 'Reply only in haiku.',
      wait: true,
    });
  });
  it('omits systemPrompt entirely from the body when not supplied', async () => {
    mockPost.mockResolvedValue({ id: 'q1', status: 'complete' });
    await client.sendChat({ notebookId: 'nb1', message: 'hi' });
    expect(mockPost).toHaveBeenCalledWith('/api/chat', { sessionId: 'nb1', message: 'hi', wait: true });
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

  it('threads an explicit page through file pagination so hasMore is reachable', async () => {
    mockGet.mockResolvedValue({ data: [{ id: 'f2' }], hasMore: false });

    await client.listFiles({ search: 'doc', limit: 25, page: 3 });

    expect(mockGet).toHaveBeenCalledWith('/api/files/search', {
      params: { search: 'doc', pagination: { page: 3, limit: 25 } },
    });
  });

  it('gets a file by id', async () => {
    mockGet.mockResolvedValue({ id: 'f1' });
    await client.getFile('f1');
    expect(mockGet).toHaveBeenCalledWith('/api/files/f1');
  });

  const jsonBody = (value: unknown) => ({
    data: Buffer.from(JSON.stringify(value)),
    headers: { 'content-type': 'application/json' },
  });

  it('generates a sound effect with base64 encoding and parses the JSON body', async () => {
    mockAxiosPost.mockResolvedValue(
      jsonBody({
        delivery: 'inline',
        audio: 'YXVkaW8tYnl0ZXM=',
        contentType: 'audio/mpeg',
        saved: true,
        fabFileId: 'fab1',
        fileName: 'sound-effect-thunderclap.mp3',
        fileUrl: 'https://signed.example/audio.mp3',
      })
    );

    const result = await client.generateSoundEffect({
      provider: 'elevenlabs',
      text: 'thunderclap',
      durationSeconds: 3,
      promptInfluence: 0.5,
      format: 'mp3_44100_128',
    });

    expect(mockAxiosPost).toHaveBeenCalledWith(
      '/api/ai/sound-effects',
      {
        provider: 'elevenlabs',
        text: 'thunderclap',
        durationSeconds: 3,
        promptInfluence: 0.5,
        format: 'mp3_44100_128',
        encoding: 'base64',
      },
      { responseType: 'arraybuffer' }
    );
    expect(result).toEqual({
      delivery: 'inline',
      audio: 'YXVkaW8tYnl0ZXM=',
      contentType: 'audio/mpeg',
      saved: true,
      fabFileId: 'fab1',
      fileName: 'sound-effect-thunderclap.mp3',
      fileUrl: 'https://signed.example/audio.mp3',
    });
  });

  it('returns the url variant for an oversized sound effect', async () => {
    mockAxiosPost.mockResolvedValue(
      jsonBody({ delivery: 'url', url: 'https://signed.example/big.mp3', bytes: 9_000_000, contentType: 'audio/mpeg' })
    );

    await expect(client.generateSoundEffect({ provider: 'elevenlabs', text: 'long' })).resolves.toEqual({
      delivery: 'url',
      url: 'https://signed.example/big.mp3',
      bytes: 9_000_000,
      contentType: 'audio/mpeg',
    });
  });

  it('normalizes an old server raw-bytes answer into the inline variant using the X-B4M-Audio headers', async () => {
    mockAxiosPost.mockResolvedValue({
      data: Buffer.from('audio-bytes'),
      headers: {
        'content-type': 'audio/mpeg',
        'x-b4m-audio-saved': 'true',
        'x-b4m-audio-fab-file-id': 'fab1',
        'x-b4m-audio-file-name': 'sound-effect-thunderclap.mp3',
        'x-b4m-audio-file-url': 'https://signed.example/audio.mp3',
      },
    });

    const result = await client.generateSoundEffect({ provider: 'elevenlabs', text: 'thunderclap' });

    expect(result).toEqual({
      delivery: 'inline',
      audio: Buffer.from('audio-bytes').toString('base64'),
      contentType: 'audio/mpeg',
      saved: true,
      fabFileId: 'fab1',
      fileName: 'sound-effect-thunderclap.mp3',
      fileUrl: 'https://signed.example/audio.mp3',
    });
  });

  it('drops the old-server file headers when the save header is not "true"', async () => {
    // A duplicated header arrives as an array; only the scalar string form is kept,
    // and none of the file headers are read at all unless the save actually succeeded.
    mockAxiosPost.mockResolvedValue({
      data: Buffer.from('audio-bytes'),
      headers: {
        'content-type': 'audio/mpeg',
        'x-b4m-audio-saved': 'false',
        'x-b4m-audio-fab-file-id': ['fab1', 'fab2'],
        'x-b4m-audio-file-url': 'https://signed.example/audio.mp3',
      },
    });

    const result = await client.generateSoundEffect({ provider: 'elevenlabs', text: 'wind' });

    expect(result).toMatchObject({ saved: false, audio: Buffer.from('audio-bytes').toString('base64') });
    expect((result as Record<string, unknown>).fabFileId).toBeUndefined();
    expect((result as Record<string, unknown>).fileName).toBeUndefined();
    expect((result as Record<string, unknown>).fileUrl).toBeUndefined();
  });

  it('reports not-saved for an old-server answer with no audio headers beyond the content type', async () => {
    mockAxiosPost.mockResolvedValue({ data: Buffer.from('bytes'), headers: { 'content-type': 'audio/mpeg' } });

    const result = await client.generateSoundEffect({ provider: 'elevenlabs', text: 'wind' });

    expect(result).toMatchObject({ delivery: 'inline', saved: false });
    expect((result as Record<string, unknown>).fabFileId).toBeUndefined();
  });

  it('decodes an arraybuffer error body so mapApiError can read the server message', async () => {
    const bodyBytes = Buffer.from(JSON.stringify({ error: 'Sound generation failed' }));
    mockAxiosPost.mockRejectedValue(axiosError(502, { data: bodyBytes }));

    await expect(client.generateSoundEffect({ provider: 'elevenlabs', text: 'x' })).rejects.toMatchObject({
      response: { data: { error: 'Sound generation failed' } },
    });
  });

  it('decodes an already-stringified error body (non-Node adapter shape)', async () => {
    mockAxiosPost.mockRejectedValue(
      axiosError(503, { data: JSON.stringify({ error: 'No elevenlabs API key configured' }) })
    );

    await expect(client.generateSoundEffect({ provider: 'elevenlabs', text: 'x' })).rejects.toMatchObject({
      response: { data: { error: 'No elevenlabs API key configured' } },
    });
  });

  it('synthesizes speech through the TTS route with base64 encoding', async () => {
    mockAxiosPost.mockResolvedValue(jsonBody({ audio: 'YWJj', format: 'mp3', contentType: 'audio/mpeg', saved: true }));

    const result = await client.synthesizeSpeech({ text: 'Hello', provider: 'openai', voice: 'alloy' });

    expect(mockAxiosPost).toHaveBeenCalledWith(
      '/api/ai/tts',
      { text: 'Hello', provider: 'openai', voice: 'alloy', encoding: 'base64' },
      { responseType: 'arraybuffer' }
    );
    expect(result).toMatchObject({ kind: 'audio', data: { audio: 'YWJj' } });
  });

  it('returns the url variant for oversized TTS audio', async () => {
    mockAxiosPost.mockResolvedValue(
      jsonBody({
        delivery: 'url',
        url: 'https://signed.example/offload.mp3',
        bytes: 5_000_000,
        format: 'mp3',
        contentType: 'audio/mpeg',
      })
    );

    await expect(client.synthesizeSpeech({ text: 'Hello' })).resolves.toMatchObject({
      kind: 'audio',
      data: { delivery: 'url', url: 'https://signed.example/offload.mp3', bytes: 5_000_000 },
    });
  });

  it('returns a saved file from a legacy 413 whose error body arrives as bytes', async () => {
    mockAxiosPost.mockRejectedValue(
      axiosError(413, {
        data: Buffer.from(
          JSON.stringify({
            error: 'Response too large',
            provider: 'elevenlabs',
            saved: true,
            fabFileId: 'fab1',
            fileUrl: 'https://signed.example/audio.mp3',
          })
        ),
      })
    );

    await expect(client.synthesizeSpeech({ text: 'Hello' })).resolves.toMatchObject({
      kind: 'saved-too-large',
      data: { fabFileId: 'fab1', fileUrl: 'https://signed.example/audio.mp3' },
    });
  });

  it('returns a saved file from an oversized billed TTS response', async () => {
    mockAxiosPost.mockRejectedValue(
      axiosError(413, {
        data: {
          error: 'Response too large',
          provider: 'elevenlabs',
          saved: true,
          fabFileId: 'fab1',
          fileUrl: 'https://signed.example/audio.mp3',
        },
      })
    );

    await expect(client.synthesizeSpeech({ text: 'Hello' })).resolves.toMatchObject({
      kind: 'saved-too-large',
      data: { fabFileId: 'fab1', fileUrl: 'https://signed.example/audio.mp3' },
    });
  });

  it('preserves an oversized TTS error when no saved file can be retrieved', async () => {
    mockAxiosPost.mockRejectedValue(axiosError(413, { data: { error: 'Response too large', provider: 'openai' } }));

    await expect(client.synthesizeSpeech({ text: 'Hello' })).rejects.toMatchObject({ response: { status: 413 } });
  });

  it('keeps the saved file id and fallback provider from an oversized TTS response without a URL', async () => {
    mockAxiosPost.mockRejectedValue(
      axiosError(413, {
        data: { error: 'Response too large', provider: 'elevenlabs', saved: true, fabFileId: 'fab1' },
        headers: { 'x-b4m-tts-provider-fallback-from': 'openai' },
      })
    );

    await expect(client.synthesizeSpeech({ text: 'Hello' })).resolves.toEqual({
      kind: 'saved-too-large',
      data: { error: 'Response too large', provider: 'elevenlabs', saved: true, fabFileId: 'fab1' },
      fallbackFrom: 'openai',
    });
  });

  it('rethrows an oversized TTS error whose body does not match the 413 schema', async () => {
    mockAxiosPost.mockRejectedValue(
      axiosError(413, { data: { error: 'Response too large', saved: true, fabFileId: 'fab1' } })
    );

    await expect(client.synthesizeSpeech({ text: 'Hello' })).rejects.toMatchObject({ response: { status: 413 } });
  });

  it('rethrows a non-413 TTS failure unchanged', async () => {
    const failure = axiosError(500, { data: { error: 'Failed to generate speech' } });
    mockAxiosPost.mockRejectedValue(failure);

    await expect(client.synthesizeSpeech({ text: 'Hello' })).rejects.toBe(failure);
  });

  it('lists projects with nested pagination and normalizes the envelope', async () => {
    mockGet.mockResolvedValue({ data: [{ id: 'p1', name: 'Proj' }], hasMore: true, total: 5 });

    const result = await client.listProjects({ limit: 100 });

    expect(mockGet).toHaveBeenCalledWith('/api/projects', {
      params: { pagination: { page: 1, limit: 100 } },
    });
    expect(result).toEqual({ data: [{ id: 'p1', name: 'Proj' }], hasMore: true });
  });

  it('threads search and an explicit page through project pagination', async () => {
    mockGet.mockResolvedValue({ data: [], hasMore: false });

    await client.listProjects({ search: 'apollo', limit: 10, page: 3 });

    expect(mockGet).toHaveBeenCalledWith('/api/projects', {
      params: { search: 'apollo', pagination: { page: 3, limit: 10 } },
    });
  });

  it('normalizes a bare-array project response to { data, hasMore:false }', async () => {
    mockGet.mockResolvedValue([{ id: 'p1' }, { id: 'p2' }]);

    expect(await client.listProjects({ limit: 100 })).toEqual({
      data: [{ id: 'p1' }, { id: 'p2' }],
      hasMore: false,
    });
  });

  it('gets a project by id (url-encoded)', async () => {
    mockGet.mockResolvedValue({ id: 'p 1' });
    await client.getProject('p 1');
    expect(mockGet).toHaveBeenCalledWith('/api/projects/p%201');
  });

  it('creates a project, forwarding name, description and non-empty id lists', async () => {
    mockPost.mockResolvedValue({ id: 'p1' });
    await client.createProject({ name: 'Apollo', description: 'Moon', sessionIds: ['s1'], fileIds: ['f1'] });
    expect(mockPost).toHaveBeenCalledWith('/api/projects', {
      name: 'Apollo',
      description: 'Moon',
      sessionIds: ['s1'],
      fileIds: ['f1'],
    });
  });

  it('omits empty id lists when creating a project', async () => {
    mockPost.mockResolvedValue({ id: 'p1' });
    await client.createProject({ name: 'Apollo', description: 'Moon', sessionIds: [], fileIds: [] });
    expect(mockPost).toHaveBeenCalledWith('/api/projects', { name: 'Apollo', description: 'Moon' });
  });

  it('lists artifacts with flat limit/offset params and normalizes the envelope', async () => {
    mockGet.mockResolvedValue({
      artifacts: [{ id: 'artifact_a_1', title: 'A' }],
      pagination: { total: 3, limit: 100, offset: 0, hasMore: true },
    });

    const result = await client.listArtifacts({ limit: 100 });

    expect(mockGet).toHaveBeenCalledWith('/api/artifacts', {
      params: { limit: 100, offset: 0 },
    });
    expect(result).toEqual({ data: [{ id: 'artifact_a_1', title: 'A' }], hasMore: true });
  });

  it('threads search and an explicit offset through the artifact list', async () => {
    mockGet.mockResolvedValue({ artifacts: [], pagination: { total: 0, limit: 10, offset: 20, hasMore: false } });

    await client.listArtifacts({ search: 'chart', limit: 10, offset: 20 });

    expect(mockGet).toHaveBeenCalledWith('/api/artifacts', {
      params: { search: 'chart', limit: 10, offset: 20 },
    });
  });

  it('defaults artifact hasMore to false when the envelope omits pagination', async () => {
    mockGet.mockResolvedValue({ artifacts: [{ id: 'artifact_a_1' }] });

    expect(await client.listArtifacts({ limit: 100 })).toEqual({
      data: [{ id: 'artifact_a_1' }],
      hasMore: false,
    });
  });

  it('gets an artifact with content, url-encoding the id', async () => {
    mockGet.mockResolvedValue({ artifact: { id: 'a 1' }, content: { content: 'hello' } });

    const result = await client.getArtifact('a 1');

    expect(mockGet).toHaveBeenCalledWith('/api/artifacts/a%201', {
      params: { includeContent: 'true' },
    });
    expect(result).toEqual({ artifact: { id: 'a 1' }, content: { content: 'hello' } });
  });
});

describe('mapApiError', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('maps 401 to a re-auth hint', () => {
    expect(mapApiError(axiosError(401), 'http://x')).toContain('authentication failed');
  });

  it.each([
    ['provider_not_configured', 'No TTS provider is configured'],
    ['provider_rejected', 'TTS request rejected by the openai provider'],
  ])('maps a 401 %s to the server message with a provider-key hint, not a re-auth hint', (errorCode, error) => {
    const msg = mapApiError(axiosError(401, { data: { error, errorCode } }), 'http://x');
    expect(msg).toContain(error);
    expect(msg).toContain('provider API key');
    expect(msg).not.toContain('b4m login');
  });

  it('falls back to generic provider text when a provider-key 401 carries no message', () => {
    const msg = mapApiError(axiosError(401, { data: { errorCode: 'provider_rejected' } }), 'http://x');
    expect(msg).toContain('the AI provider could not be used');
    expect(msg).not.toContain('b4m login');
  });

  it('keeps the re-auth hint for a 401 with an unrelated errorCode', () => {
    const msg = mapApiError(axiosError(401, { data: { error: 'nope', errorCode: 'unauthorized' } }), 'http://x');
    expect(msg).toBe('authentication failed (run `b4m login` or set B4M_API_KEY)');
  });

  it('maps NotAuthenticatedError to a no-credential message naming both fixes', () => {
    const msg = mapApiError(new NotAuthenticatedError('Authentication failed'), 'http://x');
    expect(msg).toBe('not authenticated: no credential configured (set B4M_API_KEY or run `b4m login`)');
  });

  it('gives a broad forbidden message on 403 with the recommended scope', () => {
    expect(mapApiError(axiosError(403), 'http://x', 'files:read')).toBe(
      "API key forbidden: check the key's scopes and account access (recommended scope: files:read)"
    );
  });

  it('surfaces a numeric retry-after on 429', () => {
    const msg = mapApiError(axiosError(429, { headers: { 'retry-after': '30' } }), 'http://x');
    expect(msg).toContain('rate limit');
    expect(msg).toContain('30s');
  });

  it('converts an HTTP-date retry-after into a non-negative seconds delay', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2015-10-21T07:28:00Z'));
    const msg = mapApiError(
      axiosError(429, { headers: { 'retry-after': 'Wed, 21 Oct 2015 07:28:30 GMT' } }),
      'http://x'
    );
    expect(msg).toContain('retry after 30s');
    expect(msg).not.toContain('GMT');
  });

  it('clamps a past HTTP-date retry-after to 0 seconds', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2015-10-21T07:28:00Z'));
    const msg = mapApiError(
      axiosError(429, { headers: { 'retry-after': 'Wed, 21 Oct 2015 07:27:00 GMT' } }),
      'http://x'
    );
    expect(msg).toContain('retry after 0s');
  });

  it('omits the retry hint when retry-after is unparseable', () => {
    const msg = mapApiError(axiosError(429, { headers: { 'retry-after': 'soon' } }), 'http://x');
    expect(msg).toBe('rate limit exceeded');
  });

  it('maps an axios request timeout (ECONNABORTED) to a friendly timed-out message', () => {
    expect(mapApiError(axiosError(0, { code: 'ECONNABORTED' }), 'http://localhost:3000')).toBe(
      'request to Bike4Mind at http://localhost:3000 timed out'
    );
  });

  it('maps a connect timeout (ETIMEDOUT) to the same timed-out message', () => {
    expect(mapApiError(axiosError(0, { code: 'ETIMEDOUT' }), 'http://localhost:3000')).toBe(
      'request to Bike4Mind at http://localhost:3000 timed out'
    );
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
