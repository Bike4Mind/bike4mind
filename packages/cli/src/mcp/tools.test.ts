import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { B4mApiClient } from './b4mApiClient';
import { NotAuthenticatedError } from '../auth/ApiClient';
import {
  TOOL_NAMES,
  registerTools,
  listNotebooks,
  listFiles,
  listLakes,
  createNotebook,
  sendMessage,
  searchKnowledgeBase,
  generateSoundEffect,
  generateImage,
  textToSpeech,
} from './tools';

const mockClient = (overrides: Partial<Record<keyof B4mApiClient, unknown>>): B4mApiClient =>
  ({ baseURL: 'http://localhost:3000', ...overrides }) as unknown as B4mApiClient;

describe('TOOL_NAMES', () => {
  it('exposes exactly the registered tools', () => {
    expect(TOOL_NAMES).toEqual([
      'list_notebooks',
      'get_notebook',
      'create_notebook',
      'send_message',
      'search_knowledge_base',
      'list_lakes',
      'list_files',
      'get_file',
      'generate_sound_effect',
      'text_to_speech',
      'generate_image',
    ]);
  });
});

describe('tool handlers', () => {
  it('list_notebooks projects each notebook to a summary shape', async () => {
    const client = mockClient({
      listNotebooks: vi.fn().mockResolvedValue({
        data: [{ id: 'n1', name: 'NB', lastUsedModel: 'gpt', createdAt: 'c', updatedAt: 'u' }],
        hasMore: false,
      }),
    });

    const result = await listNotebooks(client, { limit: 25 });

    expect(result).toEqual({
      notebooks: [{ id: 'n1', name: 'NB', model: 'gpt', createdAt: 'c', updatedAt: 'u' }],
      hasMore: false,
    });
  });

  it('list_notebooks forwards the requested page so a client can page past hasMore', async () => {
    const list = vi.fn().mockResolvedValue({ data: [], hasMore: false });
    const client = mockClient({ listNotebooks: list });

    await listNotebooks(client, { limit: 25, page: 2 });

    expect(list).toHaveBeenCalledWith({ limit: 25, page: 2 });
  });

  it('list_files forwards the requested page so a client can page past hasMore', async () => {
    const list = vi.fn().mockResolvedValue({ data: [], hasMore: false });
    const client = mockClient({ listFiles: list });

    await listFiles(client, { limit: 25, page: 3 });

    expect(list).toHaveBeenCalledWith({ limit: 25, page: 3 });
  });

  it('create_notebook defaults the name to "New Notebook" when omitted', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'nb1' });
    const client = mockClient({ createNotebook: create });

    await createNotebook(client, {});

    expect(create).toHaveBeenCalledWith({ name: 'New Notebook' });
  });

  it('create_notebook passes an explicit name through unchanged', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'nb1' });
    const client = mockClient({ createNotebook: create });

    await createNotebook(client, { name: 'My NB', projectId: 'p1' });

    expect(create).toHaveBeenCalledWith({ name: 'My NB', projectId: 'p1' });
  });

  it('create_notebook forwards a dataLakeId', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'nb1' });
    const client = mockClient({ createNotebook: create });

    await createNotebook(client, { dataLakeId: 'lake-1' });

    expect(create).toHaveBeenCalledWith({ name: 'New Notebook', dataLakeId: 'lake-1' });
  });

  it('list_lakes projects each lake to a summary and passes the cursor through', async () => {
    const list = vi.fn().mockResolvedValue({
      data: [
        {
          id: 'l1',
          name: 'Docs',
          slug: 'docs',
          description: 'Product docs',
          built_in: false,
          status: 'ready',
          file_count: 3,
          organization_id: 'o1',
          total_size_bytes: 99,
        },
      ],
      nextCursor: 'c2',
    });
    const client = mockClient({ listDataLakes: list });

    const result = await listLakes(client, { limit: 25, cursor: 'c1' });

    expect(list).toHaveBeenCalledWith({ limit: 25, cursor: 'c1' });
    expect(result).toEqual({
      lakes: [
        {
          id: 'l1',
          name: 'Docs',
          slug: 'docs',
          description: 'Product docs',
          builtIn: false,
          status: 'ready',
          fileCount: 3,
        },
      ],
      nextCursor: 'c2',
    });
  });

  it('send_message extracts the reply from responses and returns the supplied notebookId', async () => {
    const getQuest = vi.fn().mockResolvedValue({ id: 'q1', status: 'done', sessionId: 'other-nb' });
    // The real wait:true response carries the reply in `responses`; `response` is null.
    const client = mockClient({
      sendChat: vi
        .fn()
        .mockResolvedValue({ id: 'q1', status: 'done', response: null, responses: ['hello'], model: 'gpt' }),
      getQuest,
    });

    const result = await sendMessage(client, { message: 'hi', notebookId: 'nb1' });

    expect(result).toEqual({ notebookId: 'nb1', questId: 'q1', reply: 'hello', model: 'gpt', citables: [] });
  });

  it('send_message returns the quest citables, projected without metadata', async () => {
    const client = mockClient({
      sendChat: vi
        .fn()
        .mockResolvedValue({ id: 'q1', status: 'done', response: null, responses: ['grounded'], model: 'gpt' }),
      getQuest: vi.fn().mockResolvedValue({
        id: 'q1',
        status: 'done',
        sessionId: 'nb1',
        promptMeta: {
          citables: [
            {
              id: 'fab1',
              type: 'document',
              title: 'Handbook.pdf',
              url: '/files/fab1',
              description: 'p. 3',
              metadata: { fullContext: 'long passage text' },
            },
          ],
        },
      }),
    });

    const result = await sendMessage(client, { message: 'hi', notebookId: 'nb1' });

    expect(result.reply).toBe('grounded');
    expect(result.citables).toEqual([
      { id: 'fab1', type: 'document', title: 'Handbook.pdf', url: '/files/fab1', description: 'p. 3' },
    ]);
  });

  it('send_message still returns the reply, with citables omitted, when the quest fetch fails', async () => {
    const client = mockClient({
      sendChat: vi
        .fn()
        .mockResolvedValue({ id: 'q1', status: 'done', response: null, responses: ['hello'], model: 'gpt' }),
      getQuest: vi.fn().mockRejectedValue(new Error('boom')),
    });

    const result = await sendMessage(client, { message: 'hi', notebookId: 'nb1' });

    expect(result).toEqual({ notebookId: 'nb1', questId: 'q1', reply: 'hello', model: 'gpt', citables: undefined });
  });

  it('send_message joins multiple responses with a blank line', async () => {
    const client = mockClient({
      sendChat: vi
        .fn()
        .mockResolvedValue({ id: 'q1', status: 'done', response: null, responses: ['a', 'b'], model: 'gpt' }),
      getQuest: vi.fn(),
    });

    const result = await sendMessage(client, { message: 'hi', notebookId: 'nb1' });

    expect(result.reply).toBe('a\n\nb');
  });

  it('send_message forwards a supplied systemPrompt through to sendChat', async () => {
    const sendChat = vi
      .fn()
      .mockResolvedValue({ id: 'q1', status: 'done', response: null, responses: ['hello'], model: 'gpt' });
    const client = mockClient({ sendChat, getQuest: vi.fn() });

    await sendMessage(client, { message: 'hi', notebookId: 'nb1', systemPrompt: 'Reply only in haiku.' });

    expect(sendChat).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'hi', notebookId: 'nb1', systemPrompt: 'Reply only in haiku.' })
    );
  });

  it('send_message resolves the notebookId from the quest when none was supplied', async () => {
    const client = mockClient({
      sendChat: vi
        .fn()
        .mockResolvedValue({ id: 'q1', status: 'done', response: null, responses: ['hello'], model: 'gpt' }),
      getQuest: vi.fn().mockResolvedValue({ id: 'q1', status: 'done', sessionId: 'resolved-nb' }),
    });

    const result = await sendMessage(client, { message: 'hi' });

    expect(result.notebookId).toBe('resolved-nb');
  });

  it('send_message prefers the sessionId echoed on the chat response over the quest', async () => {
    const getQuest = vi.fn().mockResolvedValue({ id: 'q1', status: 'done', sessionId: 'quest-nb' });
    const client = mockClient({
      sendChat: vi.fn().mockResolvedValue({
        id: 'q1',
        status: 'done',
        response: null,
        responses: ['hello'],
        model: 'gpt',
        sessionId: 'echoed-nb',
      }),
      getQuest,
    });

    const result = await sendMessage(client, { message: 'hi' });

    expect(result.notebookId).toBe('echoed-nb');
    expect(getQuest).toHaveBeenCalledWith('q1');
  });

  it('search_knowledge_base wraps the score array in a results object', async () => {
    const client = mockClient({
      searchKnowledgeBase: vi.fn().mockResolvedValue([{ sessionId: 's1', maxSimilarity: 0.9, matchingMessages: 1 }]),
    });

    const result = await searchKnowledgeBase(client, { query: 'q', limit: 10 });

    expect(result).toEqual({ results: [{ sessionId: 's1', maxSimilarity: 0.9, matchingMessages: 1 }] });
  });

  it('generate_sound_effect surfaces a persisted FabFile via the forwarded signed URL (no re-fetch)', async () => {
    const getFile = vi.fn();
    const client = mockClient({
      generateSoundEffect: vi.fn().mockResolvedValue({
        delivery: 'inline',
        audio: Buffer.from('abc').toString('base64'),
        contentType: 'audio/mpeg',
        saved: true,
        fabFileId: 'fab1',
        fileName: 'sound-effect.mp3',
        fileUrl: 'https://signed',
      }),
      getFile,
    });

    const result = await generateSoundEffect(client, { text: 'thunder', provider: 'elevenlabs' });

    // The signed URL comes from the response, so no GET /api/files/:id round-trip is
    // made - that re-fetch would fail closed until the async moderation scan runs.
    expect(getFile).not.toHaveBeenCalled();
    expect(result.structuredContent).toEqual({
      saved: true,
      provider: 'elevenlabs',
      contentType: 'audio/mpeg',
      byteLength: 3,
      file: { id: 'fab1', fileName: 'sound-effect.mp3', fileUrl: 'https://signed' },
    });
    expect(result.content.some(item => item.type === 'audio')).toBe(false);
  });

  it('generate_sound_effect inlines the audio but reports the saved file id when a save yields no usable URL', async () => {
    const client = mockClient({
      generateSoundEffect: vi.fn().mockResolvedValue({
        audio: Buffer.from('abc').toString('base64'),
        contentType: 'audio/mpeg',
        saved: true,
        fabFileId: 'fab1',
      }),
    });

    const result = await generateSoundEffect(client, { text: 'thunder', provider: 'elevenlabs' });

    // Persisted but no fileUrl: hand back the bytes the caller was already billed for.
    expect(result.content).toContainEqual({
      type: 'audio',
      data: Buffer.from('abc').toString('base64'),
      mimeType: 'audio/mpeg',
    });
    expect(result.structuredContent).toEqual({
      saved: true,
      provider: 'elevenlabs',
      contentType: 'audio/mpeg',
      byteLength: 3,
      file: { id: 'fab1' },
    });
  });

  it('generate_sound_effect returns the audio inline (base64) when it was not persisted', async () => {
    const client = mockClient({
      generateSoundEffect: vi.fn().mockResolvedValue({
        audio: Buffer.from('abc').toString('base64'),
        contentType: 'audio/mpeg',
        saved: false,
        saveSkippedReason: 'storage_limit',
      }),
    });

    const result = await generateSoundEffect(client, { text: 'thunder', provider: 'elevenlabs' });

    expect(result.content).toContainEqual({
      type: 'audio',
      data: Buffer.from('abc').toString('base64'),
      mimeType: 'audio/mpeg',
    });
    expect(result.structuredContent).toEqual({
      saved: false,
      provider: 'elevenlabs',
      contentType: 'audio/mpeg',
      byteLength: 3,
      saveSkippedReason: 'storage_limit',
    });
  });

  it('generate_sound_effect returns the offloaded URL and byte count for oversized audio, with no audio block', async () => {
    const client = mockClient({
      generateSoundEffect: vi.fn().mockResolvedValue({
        delivery: 'url',
        url: 'https://signed.example/big.mp3',
        bytes: 9_000_000,
        contentType: 'audio/mpeg',
        saved: true,
        fabFileId: 'fab1',
        fileName: 'sound-effect.mp3',
        fileUrl: 'https://signed.example/file.mp3',
      }),
    });

    const result = await generateSoundEffect(client, { text: 'thunder', provider: 'elevenlabs' });

    expect(result.structuredContent).toEqual({
      provider: 'elevenlabs',
      contentType: 'audio/mpeg',
      byteLength: 9_000_000,
      url: 'https://signed.example/big.mp3',
      saved: true,
      file: { id: 'fab1', fileName: 'sound-effect.mp3', fileUrl: 'https://signed.example/file.mp3' },
    });
    expect(result.content.some(item => item.type === 'audio')).toBe(false);
  });

  it('text_to_speech returns the saved file URL and actual fallback provider', async () => {
    const client = mockClient({
      synthesizeSpeech: vi.fn().mockResolvedValue({
        kind: 'audio',
        data: {
          audio: 'YWJj',
          format: 'mp3',
          contentType: 'audio/mpeg',
          saved: true,
          fabFileId: 'fab1',
          fileUrl: 'https://signed.example/audio.mp3',
          provider: 'elevenlabs',
          fallbackFrom: 'openai',
        },
      }),
    });

    const result = await textToSpeech(client, { text: 'Hello', provider: 'openai' });

    expect(result.structuredContent).toEqual({
      saved: true,
      provider: 'elevenlabs',
      fallbackFrom: 'openai',
      format: 'mp3',
      contentType: 'audio/mpeg',
      byteLength: 3,
      file: { id: 'fab1', fileUrl: 'https://signed.example/audio.mp3' },
    });
    expect(result.content.some(item => item.type === 'audio')).toBe(false);
  });

  it('text_to_speech returns the offloaded URL and byte count for oversized audio, with no audio block', async () => {
    const client = mockClient({
      synthesizeSpeech: vi.fn().mockResolvedValue({
        kind: 'audio',
        data: {
          delivery: 'url',
          url: 'https://signed.example/offload.mp3',
          bytes: 5_000_000,
          format: 'mp3',
          contentType: 'audio/mpeg',
        },
      }),
    });

    const result = await textToSpeech(client, { text: 'Hello' });

    expect(result.structuredContent).toEqual({
      provider: 'openai',
      format: 'mp3',
      contentType: 'audio/mpeg',
      byteLength: 5_000_000,
      url: 'https://signed.example/offload.mp3',
      saved: false,
    });
    expect(result.content.some(item => item.type === 'audio')).toBe(false);
  });

  it('text_to_speech inlines the audio but reports the saved file id if a saved copy has no URL', async () => {
    const client = mockClient({
      synthesizeSpeech: vi.fn().mockResolvedValue({
        kind: 'audio',
        data: { audio: 'YWJj', format: 'mp3', contentType: 'audio/mpeg', saved: true, fabFileId: 'fab1' },
      }),
    });

    const result = await textToSpeech(client, { text: 'Hello' });

    expect(result.content).toContainEqual({ type: 'audio', data: 'YWJj', mimeType: 'audio/mpeg' });
    expect(result.structuredContent).toMatchObject({
      saved: true,
      provider: 'openai',
      byteLength: 3,
      file: { id: 'fab1' },
    });
  });

  it('text_to_speech forwards why a saved copy was skipped', async () => {
    const client = mockClient({
      synthesizeSpeech: vi.fn().mockResolvedValue({
        kind: 'audio',
        data: {
          audio: 'YWJj',
          format: 'mp3',
          contentType: 'audio/mpeg',
          saved: false,
          saveSkippedReason: 'storage_limit',
        },
      }),
    });

    const result = await textToSpeech(client, { text: 'Hello' });

    expect(result.content).toContainEqual({ type: 'audio', data: 'YWJj', mimeType: 'audio/mpeg' });
    expect(result.structuredContent).toMatchObject({ saved: false, saveSkippedReason: 'storage_limit' });
  });

  it('text_to_speech reports a too-large saved file by id when it has no URL', async () => {
    const client = mockClient({
      synthesizeSpeech: vi.fn().mockResolvedValue({
        kind: 'saved-too-large',
        data: { provider: 'elevenlabs', fabFileId: 'fab1' },
        fallbackFrom: 'openai',
      }),
    });

    const result = await textToSpeech(client, { text: 'Hello' });

    expect(result.structuredContent).toEqual({
      saved: true,
      provider: 'elevenlabs',
      fallbackFrom: 'openai',
      file: { id: 'fab1' },
    });
  });

  it('text_to_speech returns a saved URL when the billed response is too large', async () => {
    const client = mockClient({
      synthesizeSpeech: vi.fn().mockResolvedValue({
        kind: 'saved-too-large',
        data: { provider: 'openai', fabFileId: 'fab1', fileUrl: 'https://signed.example/audio.mp3' },
      }),
    });

    const result = await textToSpeech(client, { text: 'Hello' });

    expect(result.structuredContent).toEqual({
      saved: true,
      provider: 'openai',
      file: { id: 'fab1', fileUrl: 'https://signed.example/audio.mp3' },
    });
  });
});

const axiosError = (status: number) =>
  new AxiosError('request failed', undefined, {} as InternalAxiosRequestConfig, {}, {
    status,
    statusText: '',
    data: {},
    headers: {},
    config: {} as InternalAxiosRequestConfig,
  } as AxiosResponse);

describe('generateImage', () => {
  const noSleep = { sleep: vi.fn().mockResolvedValue(undefined) };
  const doneQuest = {
    id: 'q1',
    status: 'done',
    type: 'message',
    sessionId: 'nb1',
    images: ['img1.png'],
    files: [{ name: 'img1.png', url: 'https://cdn/generated/img1.png', isImage: true, isAudio: false }],
  };

  it('polls the quest until done and returns each image as id + fileName + fileUrl', async () => {
    const getQuest = vi
      .fn()
      .mockResolvedValueOnce({ id: 'q1', status: 'running', sessionId: 'nb1' })
      .mockResolvedValueOnce(doneQuest);
    const client = mockClient({
      generateImage: vi.fn().mockResolvedValue({ quest: { id: 'q1', sessionId: 'nb1' }, enhancedPrompt: 'enh' }),
      getQuest,
    });

    const result = await generateImage(client, { prompt: 'p', model: 'gpt-image-1' }, noSleep);

    expect(getQuest).toHaveBeenCalledTimes(2);
    expect(getQuest).toHaveBeenCalledWith('q1');
    expect(result).toEqual({
      notebookId: 'nb1',
      questId: 'q1',
      model: 'gpt-image-1',
      enhancedPrompt: 'enh',
      images: [{ fileName: 'img1.png', fileUrl: 'https://cdn/generated/img1.png' }],
    });
  });

  it('forwards prompt, model, size, and notebook/project association to the client', async () => {
    const generate = vi.fn().mockResolvedValue({ quest: { id: 'q1' } });
    const client = mockClient({ generateImage: generate, getQuest: vi.fn().mockResolvedValue(doneQuest) });
    const args = { prompt: 'p', model: 'gpt-image-1', size: '512x512', notebookId: 'nb1', projectId: 'pr1' };

    await generateImage(client, args, noSleep);

    expect(generate).toHaveBeenCalledWith(args);
  });

  it('throws the quest reply when the render failed', async () => {
    const client = mockClient({
      generateImage: vi.fn().mockResolvedValue({ quest: { id: 'q1' } }),
      getQuest: vi.fn().mockResolvedValue({ id: 'q1', status: 'done', type: 'error', reply: 'insufficient credits' }),
    });

    await expect(generateImage(client, { prompt: 'p', model: 'gpt-image-1' }, noSleep)).rejects.toThrow(
      'insufficient credits'
    );
  });

  it('reports a stopped quest as stopped rather than echoing its reply', async () => {
    const client = mockClient({
      generateImage: vi.fn().mockResolvedValue({ quest: { id: 'q1' } }),
      getQuest: vi.fn().mockResolvedValue({ id: 'q1', status: 'stopped', type: 'message', reply: 'enhanced prose' }),
    });

    await expect(generateImage(client, { prompt: 'p', model: 'gpt-image-1' }, noSleep)).rejects.toThrow(
      'image generation was stopped (quest q1)'
    );
  });

  it('keeps polling through a transient poll failure', async () => {
    const getQuest = vi.fn().mockRejectedValueOnce(axiosError(502)).mockResolvedValueOnce(doneQuest);
    const client = mockClient({ generateImage: vi.fn().mockResolvedValue({ quest: { id: 'q1' } }), getQuest });

    const result = await generateImage(client, { prompt: 'p', model: 'gpt-image-1' }, noSleep);

    expect(result.images).toHaveLength(1);
  });

  it('gives up after repeated poll failures', async () => {
    const getQuest = vi.fn().mockRejectedValue(axiosError(502));
    const client = mockClient({ generateImage: vi.fn().mockResolvedValue({ quest: { id: 'q1' } }), getQuest });

    await expect(generateImage(client, { prompt: 'p', model: 'gpt-image-1' }, noSleep)).rejects.toBeInstanceOf(
      AxiosError
    );
    expect(getQuest).toHaveBeenCalledTimes(3);
  });

  it('fails immediately on a permanent poll error', async () => {
    const getQuest = vi.fn().mockRejectedValue(axiosError(403));
    const client = mockClient({ generateImage: vi.fn().mockResolvedValue({ quest: { id: 'q1' } }), getQuest });

    await expect(generateImage(client, { prompt: 'p', model: 'gpt-image-1' }, noSleep)).rejects.toBeInstanceOf(
      AxiosError
    );
    expect(getQuest).toHaveBeenCalledTimes(1);
  });

  it('treats a status-less quest that already has images as finished', async () => {
    const getQuest = vi.fn().mockResolvedValue({ ...doneQuest, status: undefined });
    const client = mockClient({ generateImage: vi.fn().mockResolvedValue({ quest: { id: 'q1' } }), getQuest });

    await generateImage(client, { prompt: 'p', model: 'gpt-image-1' }, noSleep);

    expect(getQuest).toHaveBeenCalledTimes(1);
  });

  it('returns only image files and omits fileUrl when the server resolved none', async () => {
    const client = mockClient({
      generateImage: vi.fn().mockResolvedValue({ quest: { id: 'q1' } }),
      getQuest: vi.fn().mockResolvedValue({ ...doneQuest, images: ['song.mp3', 'img2.webp'], files: [] }),
    });

    const result = await generateImage(client, { prompt: 'p', model: 'gpt-image-1' }, noSleep);

    expect(result.images).toEqual([{ fileName: 'img2.webp', fileUrl: undefined }]);
  });

  it('reports progress while the render runs and stops when the call is aborted', async () => {
    const controller = new AbortController();
    const onProgress = vi.fn(() => controller.abort());
    const getQuest = vi.fn().mockResolvedValue({ id: 'q1', status: 'running' });
    const client = mockClient({ generateImage: vi.fn().mockResolvedValue({ quest: { id: 'q1' } }), getQuest });

    await expect(
      generateImage(
        client,
        { prompt: 'p', model: 'gpt-image-1' },
        { ...noSleep, signal: controller.signal, onProgress }
      )
    ).rejects.toThrow();
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(getQuest).toHaveBeenCalledTimes(1);
  });

  it('throws when the quest finishes without an image', async () => {
    const client = mockClient({
      generateImage: vi.fn().mockResolvedValue({ quest: { id: 'q1' } }),
      getQuest: vi.fn().mockResolvedValue({ id: 'q1', status: 'done', type: 'message', images: [] }),
    });

    await expect(generateImage(client, { prompt: 'p', model: 'gpt-image-1' }, noSleep)).rejects.toThrow(
      'without producing an image'
    );
  });

  it('gives up once the poll timeout elapses', async () => {
    const client = mockClient({
      generateImage: vi.fn().mockResolvedValue({ quest: { id: 'q1' } }),
      getQuest: vi.fn().mockResolvedValue({ id: 'q1', status: 'running' }),
    });

    await expect(
      generateImage(client, { prompt: 'p', model: 'gpt-image-1' }, { ...noSleep, timeoutMs: 0 })
    ).rejects.toThrow('did not finish');
  });
});

describe('registerTools', () => {
  const collectTools = (client: B4mApiClient) => {
    const tools = new Map<string, (args: unknown) => Promise<CallToolResult>>();
    const schemas = new Map<string, z.ZodRawShape>();
    const server = {
      registerTool: (
        name: string,
        config: { inputSchema: z.ZodRawShape },
        cb: (args: unknown) => Promise<CallToolResult>
      ) => {
        tools.set(name, cb);
        schemas.set(name, config.inputSchema);
      },
    } as unknown as McpServer;
    registerTools(server, client);
    return Object.assign(tools, { schemas });
  };

  // The SDK validates arguments against inputSchema before the handler runs, so a field
  // missing from a shape is silently stripped and never reaches the client.
  it('create_notebook input schema keeps dataLakeId', () => {
    const shape = collectTools(mockClient({})).schemas.get('create_notebook')!;
    expect(z.object(shape).parse({ name: 'n', dataLakeId: 'l1' })).toEqual({ name: 'n', dataLakeId: 'l1' });
  });

  it('list_lakes input schema keeps cursor and defaults limit to 25', () => {
    const shape = collectTools(mockClient({})).schemas.get('list_lakes')!;
    expect(z.object(shape).parse({ cursor: 'c1' })).toEqual({ cursor: 'c1', limit: 25 });
  });

  it('registers every tool in TOOL_NAMES', () => {
    const tools = collectTools(mockClient({}));
    expect([...tools.keys()]).toEqual(TOOL_NAMES);
  });

  it('returns a structured result on success', async () => {
    const tools = collectTools(mockClient({ listNotebooks: vi.fn().mockResolvedValue({ data: [], hasMore: false }) }));
    const result = await tools.get('list_notebooks')!({ limit: 25 });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ notebooks: [], hasMore: false });
  });

  it('maps a no-credential failure to a structured isError naming B4M_API_KEY and b4m login', async () => {
    const tools = collectTools(
      mockClient({ listNotebooks: vi.fn().mockRejectedValue(new NotAuthenticatedError('Authentication failed')) })
    );

    const result = await tools.get('list_notebooks')!({ limit: 25 });

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: 'text' });
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('B4M_API_KEY');
    expect(text).toContain('b4m login');
    expect(text).not.toContain('expired');
  });

  it('maps an API failure to a structured isError result naming the scope', async () => {
    const forbidden = new AxiosError('forbidden', undefined, {} as InternalAxiosRequestConfig, {}, {
      status: 403,
      statusText: '',
      data: {},
      headers: {},
      config: {} as InternalAxiosRequestConfig,
    } as AxiosResponse);
    const tools = collectTools(mockClient({ getFile: vi.fn().mockRejectedValue(forbidden) }));

    const result = await tools.get('get_file')!({ fileId: 'f1' });

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: "API key forbidden: check the key's scopes and account access (recommended scope: files:read)",
    });
  });

  it('maps a FEATURE_DISABLED 403 to a feature-disabled message, not a scope hint', async () => {
    const disabled = new AxiosError('forbidden', undefined, {} as InternalAxiosRequestConfig, {}, {
      status: 403,
      statusText: '',
      data: { error: 'Feature not available', code: 'FEATURE_DISABLED' },
      headers: {},
      config: {} as InternalAxiosRequestConfig,
    } as AxiosResponse);
    const tools = collectTools(mockClient({ listDataLakes: vi.fn().mockRejectedValue(disabled) }));

    const result = await tools.get('list_lakes')!({ limit: 25 });

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: 'feature disabled on this Bike4Mind instance (ask an admin to enable it)',
    });
  });

  it('list_lakes maps a 403 to a structured isError naming datalake:read', async () => {
    const forbidden = new AxiosError('forbidden', undefined, {} as InternalAxiosRequestConfig, {}, {
      status: 403,
      statusText: '',
      data: {},
      headers: {},
      config: {} as InternalAxiosRequestConfig,
    } as AxiosResponse);
    const tools = collectTools(mockClient({ listDataLakes: vi.fn().mockRejectedValue(forbidden) }));

    const result = await tools.get('list_lakes')!({ limit: 25 });

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: "API key forbidden: check the key's scopes and account access (recommended scope: datalake:read)",
    });
  });

  it('generate_sound_effect surfaces a persisted file as a JSON result with the signed URL', async () => {
    const tools = collectTools(
      mockClient({
        generateSoundEffect: vi.fn().mockResolvedValue({
          audio: Buffer.from('abc').toString('base64'),
          contentType: 'audio/mpeg',
          saved: true,
          fabFileId: 'fab1',
          fileName: 'sound-effect.mp3',
          fileUrl: 'https://signed',
        }),
      })
    );

    const result = await tools.get('generate_sound_effect')!({ text: 'rain', provider: 'elevenlabs' });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ saved: true, file: { id: 'fab1', fileUrl: 'https://signed' } });
    expect(result.content.some(c => c.type === 'audio')).toBe(false);
  });

  it('generate_sound_effect returns an audio content block when the bytes were not persisted', async () => {
    const tools = collectTools(
      mockClient({
        generateSoundEffect: vi.fn().mockResolvedValue({
          audio: Buffer.from('abc').toString('base64'),
          contentType: 'audio/mpeg',
          saved: false,
        }),
      })
    );

    const result = await tools.get('generate_sound_effect')!({ text: 'rain', provider: 'elevenlabs' });

    expect(result.isError).toBeFalsy();
    expect(result.content).toContainEqual({
      type: 'audio',
      data: Buffer.from('abc').toString('base64'),
      mimeType: 'audio/mpeg',
    });
    // The base64 payload stays out of structuredContent to avoid duplicating it.
    expect(result.structuredContent).toEqual({
      saved: false,
      provider: 'elevenlabs',
      contentType: 'audio/mpeg',
      byteLength: 3,
    });
  });

  it('generate_sound_effect maps an API failure to a structured isError naming ai:generate', async () => {
    const forbidden = new AxiosError('forbidden', undefined, {} as InternalAxiosRequestConfig, {}, {
      status: 403,
      statusText: '',
      data: {},
      headers: {},
      config: {} as InternalAxiosRequestConfig,
    } as AxiosResponse);
    const tools = collectTools(mockClient({ generateSoundEffect: vi.fn().mockRejectedValue(forbidden) }));

    const result = await tools.get('generate_sound_effect')!({ text: 'rain', provider: 'elevenlabs' });

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: "API key forbidden: check the key's scopes and account access (recommended scope: ai:generate)",
    });
  });

  it('text_to_speech maps a scope failure to an MCP error', async () => {
    const forbidden = new AxiosError('forbidden', undefined, {} as InternalAxiosRequestConfig, {}, {
      status: 403,
      statusText: '',
      data: {},
      headers: {},
      config: {} as InternalAxiosRequestConfig,
    } as AxiosResponse);
    const tools = collectTools(mockClient({ synthesizeSpeech: vi.fn().mockRejectedValue(forbidden) }));

    const result = await tools.get('text_to_speech')!({ text: 'Hello' });

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: "API key forbidden: check the key's scopes and account access (recommended scope: ai:generate)",
    });
  });

  const ttsFailure = (status: number, data: Record<string, unknown>) =>
    new AxiosError('request failed', undefined, {} as InternalAxiosRequestConfig, {}, {
      status,
      statusText: '',
      data,
      headers: {},
      config: {} as InternalAxiosRequestConfig,
    } as AxiosResponse);

  it.each(['provider_not_configured', 'provider_rejected'])(
    'text_to_speech maps a 401 %s to a provider-key hint rather than b4m login',
    async errorCode => {
      const failure = ttsFailure(401, { error: 'No usable TTS provider', errorCode });
      const tools = collectTools(mockClient({ synthesizeSpeech: vi.fn().mockRejectedValue(failure) }));

      const result = await tools.get('text_to_speech')!({ text: 'Hello' });

      expect(result.isError).toBe(true);
      const [first] = result.content;
      const text = first.type === 'text' ? first.text : '';
      expect(text).toContain('No usable TTS provider');
      expect(text).toContain('provider API key');
      expect(text).not.toContain('b4m login');
    }
  );

  it('text_to_speech surfaces the server message for insufficient credits', async () => {
    const failure = ttsFailure(422, { error: 'Not enough credits for TTS', errorCode: 'insufficient_credits' });
    const tools = collectTools(mockClient({ synthesizeSpeech: vi.fn().mockRejectedValue(failure) }));

    const result = await tools.get('text_to_speech')!({ text: 'Hello' });

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'Not enough credits for TTS' });
  });

  it('generate_image maps an API failure to a structured isError naming ai:generate', async () => {
    const forbidden = new AxiosError('forbidden', undefined, {} as InternalAxiosRequestConfig, {}, {
      status: 403,
      statusText: '',
      data: {},
      headers: {},
      config: {} as InternalAxiosRequestConfig,
    } as AxiosResponse);
    const tools = collectTools(mockClient({ generateImage: vi.fn().mockRejectedValue(forbidden) }));

    const result = await (tools.get('generate_image') as (a: unknown, e: unknown) => Promise<CallToolResult>)(
      { prompt: 'p', model: 'gpt-image-1' },
      { signal: new AbortController().signal, sendNotification: vi.fn() }
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: "API key forbidden: check the key's scopes and account access (recommended scope: ai:generate)",
    });
  });
});
