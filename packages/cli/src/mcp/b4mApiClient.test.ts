import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { B4mApiError } from '@bike4mind/sdk';

const mockGet = vi.fn();
const mockPost = vi.fn();
const mockPut = vi.fn();
const mockDelete = vi.fn();
// The SDK calls go through ApiClient.fetch.
const mockFetch = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>();
vi.mock('../auth/ApiClient', () => ({
  ApiClient: class {
    get = mockGet;
    post = mockPost;
    put = mockPut;
    delete = mockDelete;
    fetch = mockFetch;
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

const jsonResponse = (body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) =>
  new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });

/** The last request the SDK sent through ApiClient.fetch. */
function sent() {
  const [url, init] = mockFetch.mock.calls[mockFetch.mock.calls.length - 1] ?? [];
  return {
    url: String(url),
    method: init?.method,
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
    redirect: init?.redirect,
  };
}

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
    mockFetch.mockResolvedValue(jsonResponse({ id: 'n 1' }));
    await expect(client.getNotebook('n 1')).resolves.toEqual({ id: 'n 1' });
    expect(sent()).toMatchObject({ url: 'http://localhost:3000/api/sessions/n%201', method: 'GET' });
  });

  it('posts the briefcase catalog queries and unwraps the catalog map', async () => {
    const catalog = { general: [{ id: 'p1', name: 'Summarize' }] };
    mockPost.mockResolvedValue({ catalog });
    const queries = [{ key: 'general', type: 'general' }];
    await expect(client.getBriefcaseCatalog(queries)).resolves.toEqual(catalog);
    // Origin satisfies the route's csrfProtection for a login (JWT) caller.
    expect(mockPost).toHaveBeenCalledWith(
      '/api/briefcase/catalog',
      { queries },
      { headers: { Origin: 'http://localhost:3000' } }
    );
  });

  it('gets a briefcase prompt by id (url-encoded) and unwraps it', async () => {
    const prompt = { id: 'p 1', name: 'Summarize', promptText: 'Hi' };
    mockGet.mockResolvedValue({ prompt });
    await expect(client.getBriefcasePrompt('p 1')).resolves.toEqual(prompt);
    expect(mockGet).toHaveBeenCalledWith('/api/briefcase/prompts/p%201');
  });

  it('creates a notebook with only the provided fields', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ id: 'n1' }));
    await client.createNotebook({ name: 'My NB' });
    expect(sent()).toEqual({
      url: 'http://localhost:3000/api/v1/sessions',
      method: 'POST',
      body: { name: 'My NB' },
      redirect: undefined,
    });
  });

  it('queues an image generation, mapping notebookId to sessionId and omitting unset fields', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ quest: { id: 'q1' } }));

    await client.generateImage({ prompt: 'a lighthouse', model: 'gpt-image-1', notebookId: 'nb1' });

    expect(sent()).toMatchObject({
      url: 'http://localhost:3000/api/v1/image-generations',
      method: 'POST',
      body: { prompt: 'a lighthouse', model: 'gpt-image-1', sessionId: 'nb1' },
    });
  });

  it('forwards size and projectId on an image generation', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ quest: { id: 'q1' } }));

    await client.generateImage({ prompt: 'p', model: 'gpt-image-1', size: '1024x1024', projectId: 'p1' });

    expect(sent().body).toEqual({ prompt: 'p', model: 'gpt-image-1', size: '1024x1024', projectId: 'p1' });
  });

  it('sends prompt_resolution on an image generation when promptResolution is set', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ quest: { id: 'q1' } }));

    await client.generateImage({ prompt: 'p', model: 'gpt-image-2', promptResolution: 'literal' });

    expect(sent().body).toEqual({ prompt: 'p', model: 'gpt-image-2', prompt_resolution: 'literal' });
  });

  it('forwards dataLakeId on create only when set', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ id: 'n1' }));
    await client.createNotebook({ name: 'My NB', dataLakeId: 'lake-1' });
    expect(sent().body).toEqual({ name: 'My NB', dataLakeId: 'lake-1' });
  });

  const NB_ID = '64b7f0c2a1e4d5f6a7b8c9d0';

  it('renames a notebook via PUT with only the name', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ id: NB_ID }));
    await client.renameNotebook(NB_ID, 'Renamed');
    expect(sent()).toMatchObject({
      url: `http://localhost:3000/api/sessions/${NB_ID}`,
      method: 'PUT',
      body: { name: 'Renamed' },
    });
  });

  it('clones a notebook via POST .../clone', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ id: 'n2' }));
    await client.cloneNotebook(NB_ID);
    expect(sent()).toMatchObject({
      url: `http://localhost:3000/api/v1/sessions/${NB_ID}/clone`,
      method: 'POST',
      body: {},
    });
  });

  it('deletes a notebook via DELETE without following redirects', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ newLastNotebookId: null }));
    await expect(client.deleteNotebook(NB_ID)).resolves.toEqual({ newLastNotebookId: null });
    expect(sent()).toMatchObject({
      url: `http://localhost:3000/api/sessions/${NB_ID}`,
      method: 'DELETE',
      redirect: 'manual',
    });
  });

  // '' or '.' would reach DELETE /api/sessions (delete-all) after the trailing-slash redirect.
  it.each(['', '.', '..', 'n 1', `${NB_ID}/..`])(
    'refuses notebook id %j on every write without a request',
    async id => {
      await expect(client.renameNotebook(id, 'x')).rejects.toThrow('Invalid notebook id');
      await expect(client.cloneNotebook(id)).rejects.toThrow('Invalid notebook id');
      await expect(client.deleteNotebook(id)).rejects.toThrow('Invalid notebook id');
      expect(mockFetch).not.toHaveBeenCalled();
    }
  );

  it('lists data lakes with flat limit/cursor params and maps next_cursor', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: [{ id: 'l1', name: 'Lake', slug: 'lake' }], next_cursor: 'c2' }));
    const result = await client.listDataLakes({ limit: 10, cursor: 'c1' });
    expect(sent().url).toBe('http://localhost:3000/api/v1/data-lakes?limit=10&cursor=c1');
    expect(result).toEqual({ data: [{ id: 'l1', name: 'Lake', slug: 'lake' }], nextCursor: 'c2' });
  });

  it('omits cursor when listing the first page of data lakes', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: [], next_cursor: null }));
    const result = await client.listDataLakes({ limit: 25 });
    expect(sent().url).toBe('http://localhost:3000/api/v1/data-lakes?limit=25');
    expect(result).toEqual({ data: [], nextCursor: null });
  });

  it('sends a chat message with wait:false and maps notebookId to sessionId', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ id: 'q1', status: 'queued' }));
    await client.sendChat({ notebookId: 'nb1', message: 'hi', model: 'gpt' });
    expect(sent()).toMatchObject({ url: 'http://localhost:3000/api/chat', method: 'POST' });
    expect(sent().body).toEqual({
      sessionId: 'nb1',
      message: 'hi',
      model: 'gpt',
      wait: false,
    });
  });

  it('starts a new conversation when no notebookId is supplied', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ id: 'q1', status: 'queued', sessionId: 'fresh-nb' }));
    await client.sendChat({ message: 'hi' });
    expect(sent().body).toEqual({
      newConversation: true,
      message: 'hi',
      wait: false,
    });
  });

  it('forwards a supplied systemPrompt in the chat body', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ id: 'q1', status: 'queued' }));
    await client.sendChat({ notebookId: 'nb1', message: 'hi', systemPrompt: 'Reply only in haiku.' });
    expect(sent().body).toEqual({
      sessionId: 'nb1',
      message: 'hi',
      systemPrompt: 'Reply only in haiku.',
      wait: false,
    });
  });
  it('omits systemPrompt entirely from the body when not supplied', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ id: 'q1', status: 'queued' }));
    await client.sendChat({ notebookId: 'nb1', message: 'hi' });
    expect(sent().body).toEqual({ sessionId: 'nb1', message: 'hi', wait: false });
  });

  it('polls the v1 quest route', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ id: 'q 1', status: 'done', sessionId: 's1' }));
    await expect(client.getQuest('q 1')).resolves.toMatchObject({ status: 'done' });
    expect(sent()).toMatchObject({ url: 'http://localhost:3000/api/v1/quests/q%201', method: 'GET' });
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

  it('generates a sound effect with base64 encoding and parses the JSON body', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
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

    expect(sent()).toMatchObject({
      url: 'http://localhost:3000/api/ai/sound-effects',
      method: 'POST',
      body: {
        provider: 'elevenlabs',
        text: 'thunderclap',
        durationSeconds: 3,
        promptInfluence: 0.5,
        format: 'mp3_44100_128',
        encoding: 'base64',
      },
    });
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
    mockFetch.mockResolvedValue(
      jsonResponse({
        delivery: 'url',
        url: 'https://signed.example/big.mp3',
        bytes: 9_000_000,
        contentType: 'audio/mpeg',
      })
    );

    await expect(client.generateSoundEffect({ provider: 'elevenlabs', text: 'long' })).resolves.toEqual({
      delivery: 'url',
      url: 'https://signed.example/big.mp3',
      bytes: 9_000_000,
      contentType: 'audio/mpeg',
    });
  });

  it('normalizes an old server raw-bytes answer into the inline variant using the X-B4M-Audio headers', async () => {
    mockFetch.mockResolvedValue(
      new Response(Buffer.from('audio-bytes'), {
        headers: {
          'content-type': 'audio/mpeg',
          'x-b4m-audio-saved': 'true',
          'x-b4m-audio-fab-file-id': 'fab1',
          'x-b4m-audio-file-name': 'sound-effect-thunderclap.mp3',
          'x-b4m-audio-file-url': 'https://signed.example/audio.mp3',
        },
      })
    );

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
    mockFetch.mockResolvedValue(
      new Response(Buffer.from('audio-bytes'), {
        headers: {
          'content-type': 'audio/mpeg',
          'x-b4m-audio-saved': 'false',
          'x-b4m-audio-fab-file-id': 'fab1',
          'x-b4m-audio-file-url': 'https://signed.example/audio.mp3',
        },
      })
    );

    const result = await client.generateSoundEffect({ provider: 'elevenlabs', text: 'wind' });

    expect(result).toMatchObject({ saved: false, audio: Buffer.from('audio-bytes').toString('base64') });
    expect((result as Record<string, unknown>).fabFileId).toBeUndefined();
    expect((result as Record<string, unknown>).fileName).toBeUndefined();
    expect((result as Record<string, unknown>).fileUrl).toBeUndefined();
  });

  it('reports not-saved for an old-server answer with no audio headers beyond the content type', async () => {
    mockFetch.mockResolvedValue(new Response(Buffer.from('bytes'), { headers: { 'content-type': 'audio/mpeg' } }));

    const result = await client.generateSoundEffect({ provider: 'elevenlabs', text: 'wind' });

    expect(result).toMatchObject({ delivery: 'inline', saved: false });
    expect((result as Record<string, unknown>).fabFileId).toBeUndefined();
  });

  it('surfaces an audio failure as a B4mApiError mapApiError can read', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ error: 'Sound generation failed' }, { status: 502 }));

    const error = await client.generateSoundEffect({ provider: 'elevenlabs', text: 'x' }).catch(e => e);
    expect(error).toBeInstanceOf(B4mApiError);
    expect(mapApiError(error, 'http://x')).toBe('Sound generation failed');
  });

  it('synthesizes speech through the TTS route with base64 encoding', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ audio: 'YWJj', format: 'mp3', contentType: 'audio/mpeg', saved: true }));

    const result = await client.synthesizeSpeech({ text: 'Hello', provider: 'openai', voice: 'alloy' });

    expect(sent()).toMatchObject({
      url: 'http://localhost:3000/api/ai/tts',
      body: { text: 'Hello', provider: 'openai', voice: 'alloy', encoding: 'base64' },
    });
    expect(result).toMatchObject({ kind: 'audio', data: { audio: 'YWJj' } });
  });

  it('returns the url variant for oversized TTS audio', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({
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

  it('returns a saved file from an oversized billed TTS response', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(
        {
          error: 'Response too large',
          provider: 'elevenlabs',
          saved: true,
          fabFileId: 'fab1',
          fileUrl: 'https://signed.example/audio.mp3',
        },
        { status: 413 }
      )
    );

    await expect(client.synthesizeSpeech({ text: 'Hello' })).resolves.toMatchObject({
      kind: 'saved-too-large',
      data: { fabFileId: 'fab1', fileUrl: 'https://signed.example/audio.mp3' },
    });
  });

  it('preserves an oversized TTS error when no saved file can be retrieved', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ error: 'Response too large', provider: 'openai' }, { status: 413 }));

    await expect(client.synthesizeSpeech({ text: 'Hello' })).rejects.toMatchObject({ status: 413 });
  });

  it('keeps the saved file id and fallback provider from an oversized TTS response without a URL', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(
        { error: 'Response too large', provider: 'elevenlabs', saved: true, fabFileId: 'fab1' },
        { status: 413, headers: { 'x-b4m-tts-provider-fallback-from': 'openai' } }
      )
    );

    await expect(client.synthesizeSpeech({ text: 'Hello' })).resolves.toEqual({
      kind: 'saved-too-large',
      data: { error: 'Response too large', provider: 'elevenlabs', saved: true, fabFileId: 'fab1' },
      fallbackFrom: 'openai',
    });
  });

  it('drops a fallback provider header that names no known vendor', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(
        { error: 'Response too large', provider: 'elevenlabs', saved: true, fabFileId: 'fab1' },
        { status: 413, headers: { 'x-b4m-tts-provider-fallback-from': 'nobody' } }
      )
    );

    expect(await client.synthesizeSpeech({ text: 'Hello' })).not.toHaveProperty('fallbackFrom');
  });

  it('rethrows an oversized TTS error whose body does not match the 413 schema', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse({ error: 'Response too large', saved: true, fabFileId: 'fab1' }, { status: 413 })
    );

    await expect(client.synthesizeSpeech({ text: 'Hello' })).rejects.toMatchObject({ status: 413 });
  });

  it('rethrows a non-413 TTS failure', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ error: 'Failed to generate speech' }, { status: 500 }));

    await expect(client.synthesizeSpeech({ text: 'Hello' })).rejects.toMatchObject({
      status: 500,
      message: 'Failed to generate speech',
    });
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

  const v1Project = {
    id: 'p1',
    name: 'Apollo',
    description: 'Moon',
    session_ids: ['s1'],
    file_ids: ['f1'],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
  };

  it('creates a project via v1, mapping the id lists and the snake_case resource', async () => {
    mockFetch.mockResolvedValue(jsonResponse(v1Project, { status: 201 }));
    const project = await client.createProject({
      name: 'Apollo',
      description: 'Moon',
      sessionIds: ['s1'],
      fileIds: ['f1'],
    });
    expect(sent()).toMatchObject({
      url: 'http://localhost:3000/api/v1/projects',
      method: 'POST',
      body: { name: 'Apollo', description: 'Moon', session_ids: ['s1'], file_ids: ['f1'] },
    });
    expect(project).toEqual({
      id: 'p1',
      name: 'Apollo',
      description: 'Moon',
      sessionIds: ['s1'],
      fileIds: ['f1'],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
  });

  it('omits empty id lists when creating a project', async () => {
    mockFetch.mockResolvedValue(jsonResponse(v1Project, { status: 201 }));
    await client.createProject({ name: 'Apollo', description: 'Moon', sessionIds: [], fileIds: [] });
    expect(sent().body).toEqual({ name: 'Apollo', description: 'Moon' });
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

  const sdkError = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new B4mApiError(status, body, new Headers(headers));

  it('maps an SDK B4mApiError like the axios error it replaced', () => {
    expect(mapApiError(sdkError(401, { error: 'x' }), 'http://x')).toContain('authentication failed');
    expect(mapApiError(sdkError(401, { error: 'No key', errorCode: 'provider_not_configured' }), 'http://x')).toContain(
      'provider API key'
    );
    expect(mapApiError(sdkError(403, {}), 'http://x', 'ai:chat')).toContain('recommended scope: ai:chat');
    expect(mapApiError(sdkError(429, { error: 'Slow down' }, { 'retry-after': '12' }), 'http://x')).toBe(
      'Slow down (retry after 12s)'
    );
    expect(mapApiError(sdkError(400, { error: 'Query is required' }), 'http://x')).toBe('Query is required');
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

  it('surfaces the CSRF origin message on a 403 instead of the API-key fallback', () => {
    const msg = mapApiError(
      axiosError(403, {
        data: { error: 'Invalid request origin. CSRF protection triggered (expected https://app.example.com).' },
      }),
      'http://x',
      'files:read'
    );
    expect(msg).toContain('CSRF protection triggered');
    expect(msg).not.toContain('API key forbidden');
  });

  it('keeps the API-key scope fallback for a non-CSRF 403 that carries a server body', () => {
    expect(mapApiError(axiosError(403, { data: { error: 'Insufficient scope' } }), 'http://x', 'files:read')).toBe(
      "API key forbidden: check the key's scopes and account access (recommended scope: files:read)"
    );
  });

  it.each([
    'CSRF: APP_URL is not configured on this deployment.',
    'CSRF: APP_URL is not a valid absolute URL on this deployment.',
    'CSRF: APP_URL does not resolve to a usable origin on this deployment.',
    'Invalid request origin. CSRF protection triggered (expected https://app.example.com).',
  ])('passes a csrfProtection 403 message through unchanged: %s', message => {
    expect(mapApiError(axiosError(403, { data: { error: message } }), 'http://x', 'files:read')).toBe(message);
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
