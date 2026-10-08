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
  renameNotebook,
  cloneNotebook,
  deleteNotebook,
  listProjects,
  getProject,
  createProject,
  sendMessage,
  searchKnowledgeBase,
  generateSoundEffect,
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
      'rename_notebook',
      'clone_notebook',
      'delete_notebook',
      'list_projects',
      'get_project',
      'create_project',
      'send_message',
      'search_knowledge_base',
      'list_lakes',
      'list_files',
      'get_file',
      'generate_sound_effect',
      'text_to_speech',
    ]);
  });
});

describe('tool handlers', () => {
  const raw = { id: 'n2', name: 'NB', lastUsedModel: 'gpt', createdAt: 'c', updatedAt: 'u', extra: 'x' };
  const summary = { id: 'n2', name: 'NB', model: 'gpt', createdAt: 'c', updatedAt: 'u' };

  it('rename_notebook renames and returns the summary', async () => {
    const rename = vi.fn().mockResolvedValue(raw);
    const result = await renameNotebook(mockClient({ renameNotebook: rename }), { notebookId: 'n1', name: 'NB' });
    expect(rename).toHaveBeenCalledWith('n1', 'NB');
    expect(result).toEqual(summary);
  });

  it('clone_notebook returns the summary of the new notebook', async () => {
    const clone = vi.fn().mockResolvedValue(raw);
    const result = await cloneNotebook(mockClient({ cloneNotebook: clone }), { notebookId: 'n1' });
    expect(clone).toHaveBeenCalledWith('n1');
    expect(result).toEqual(summary);
  });

  it('delete_notebook deletes with confirm: true', async () => {
    const del = vi.fn().mockResolvedValue({ newLastNotebookId: 'n9' });
    const result = await deleteNotebook(mockClient({ deleteNotebook: del }), { notebookId: 'n1', confirm: true });
    expect(del).toHaveBeenCalledWith('n1');
    expect(result).toEqual({ deleted: true, notebookId: 'n1', newLastNotebookId: 'n9' });
  });

  it.each([false, undefined])('delete_notebook refuses confirm: %s without calling the API', async confirm => {
    const del = vi.fn();
    await expect(deleteNotebook(mockClient({ deleteNotebook: del }), { notebookId: 'n1', confirm })).rejects.toThrow(
      'confirm: true'
    );
    expect(del).not.toHaveBeenCalled();
  });

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

  it('list_projects projects each project to a summary and forwards search and page', async () => {
    const list = vi.fn().mockResolvedValue({
      data: [{ id: 'p1', name: 'Apollo', description: 'Moon', createdAt: 'c', updatedAt: 'u' }],
      hasMore: true,
    });
    const client = mockClient({ listProjects: list });

    const result = await listProjects(client, { search: 'apo', limit: 25, page: 2 });

    expect(list).toHaveBeenCalledWith({ search: 'apo', limit: 25, page: 2 });
    expect(result).toEqual({ projects: [{ id: 'p1', name: 'Apollo', createdAt: 'c' }], hasMore: true });
  });

  it('get_project returns the raw project document', async () => {
    const doc = { id: 'p1', name: 'Apollo', description: 'Moon', sessionIds: ['s1'] };
    const get = vi.fn().mockResolvedValue(doc);
    const client = mockClient({ getProject: get });

    expect(await getProject(client, { projectId: 'p1' })).toEqual(doc);
    expect(get).toHaveBeenCalledWith('p1');
  });

  it('create_project forwards its fields and returns a summary', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'p1', name: 'Apollo', description: 'Moon', createdAt: 'c' });
    const client = mockClient({ createProject: create });

    const args = { name: 'Apollo', description: 'Moon', sessionIds: ['s1'] };
    const result = await createProject(client, args);

    expect(create).toHaveBeenCalledWith(args);
    expect(result).toEqual({ id: 'p1', name: 'Apollo', createdAt: 'c' });
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

  const NB_ID = '64b7f0c2a1e4d5f6a7b8c9d0';

  it('delete_notebook input schema rejects a missing or false confirm', () => {
    const schema = z.object(collectTools(mockClient({})).schemas.get('delete_notebook')!);
    expect(schema.safeParse({ notebookId: NB_ID }).success).toBe(false);
    expect(schema.safeParse({ notebookId: NB_ID, confirm: false }).success).toBe(false);
    expect(schema.safeParse({ notebookId: NB_ID, confirm: true }).success).toBe(true);
  });

  it('rename_notebook input schema rejects an empty name', () => {
    const schema = z.object(collectTools(mockClient({})).schemas.get('rename_notebook')!);
    expect(schema.safeParse({ notebookId: NB_ID, name: '' }).success).toBe(false);
  });

  // An empty or dot-segment id collapses the URL onto /api/sessions, whose DELETE wipes every notebook.
  it.each([
    ['get_notebook', {}],
    ['rename_notebook', { name: 'x' }],
    ['clone_notebook', {}],
    ['delete_notebook', { confirm: true }],
  ] as const)('%s input schema accepts only an ObjectId notebookId', (tool, rest) => {
    const schema = z.object(collectTools(mockClient({})).schemas.get(tool)!);
    for (const bad of ['', '.', '..', 'n1', `${NB_ID}/..`, NB_ID.slice(1)]) {
      expect(schema.safeParse({ notebookId: bad, ...rest }).success).toBe(false);
    }
    expect(schema.safeParse({ notebookId: NB_ID, ...rest }).success).toBe(true);
  });

  it.each([
    ['rename_notebook', 'renameNotebook', { notebookId: NB_ID, name: 'x' }],
    ['clone_notebook', 'cloneNotebook', { notebookId: NB_ID }],
    ['delete_notebook', 'deleteNotebook', { notebookId: NB_ID, confirm: true }],
  ] as const)('%s maps a 403 to an isError naming notebooks:write', async (tool, method, args) => {
    const forbidden = new AxiosError('forbidden', undefined, {} as InternalAxiosRequestConfig, {}, {
      status: 403,
      statusText: '',
      data: {},
      headers: {},
      config: {} as InternalAxiosRequestConfig,
    } as AxiosResponse);
    const tools = collectTools(mockClient({ [method]: vi.fn().mockRejectedValue(forbidden) }));

    const result = await tools.get(tool)!(args);

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('recommended scope: notebooks:write');
  });

  it.each([
    [404, 'Session not found'],
    [409, 'Session is being modified, retry'],
  ])('delete_notebook surfaces the server message of a %s', async (status, message) => {
    const err = new AxiosError('failed', undefined, {} as InternalAxiosRequestConfig, {}, {
      status,
      statusText: '',
      data: { message },
      headers: {},
      config: {} as InternalAxiosRequestConfig,
    } as AxiosResponse);
    const tools = collectTools(mockClient({ deleteNotebook: vi.fn().mockRejectedValue(err) }));

    const result = await tools.get('delete_notebook')!({ notebookId: NB_ID, confirm: true });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toBe(message);
  });

  it('clone_notebook surfaces a 429 with its Retry-After', async () => {
    const err = new AxiosError('failed', undefined, {} as InternalAxiosRequestConfig, {}, {
      status: 429,
      statusText: '',
      data: {},
      headers: { 'retry-after': '42' },
      config: {} as InternalAxiosRequestConfig,
    } as AxiosResponse);
    const tools = collectTools(mockClient({ cloneNotebook: vi.fn().mockRejectedValue(err) }));

    const result = await tools.get('clone_notebook')!({ notebookId: NB_ID });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toBe('rate limit exceeded (retry after 42s)');
  });

  it('create_project input schema requires name and description and keeps id lists', () => {
    const shape = z.object(collectTools(mockClient({})).schemas.get('create_project')!);
    expect(shape.safeParse({ name: 'n' }).success).toBe(false);
    expect(shape.safeParse({ name: '', description: 'd' }).success).toBe(false);
    expect(shape.parse({ name: 'n', description: 'd', sessionIds: ['s1'], fileIds: ['f1'] })).toEqual({
      name: 'n',
      description: 'd',
      sessionIds: ['s1'],
      fileIds: ['f1'],
    });
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

  it.each([
    ['list_projects', 'listProjects', { limit: 25 }, 'projects:read'],
    ['get_project', 'getProject', { projectId: 'p1' }, 'projects:read'],
    ['create_project', 'createProject', { name: 'n', description: 'd' }, 'projects:write'],
  ] as const)('%s maps a 403 to a structured isError naming its scope', async (tool, method, args, scope) => {
    const forbidden = new AxiosError('forbidden', undefined, {} as InternalAxiosRequestConfig, {}, {
      status: 403,
      statusText: '',
      data: {},
      headers: {},
      config: {} as InternalAxiosRequestConfig,
    } as AxiosResponse);
    const tools = collectTools(mockClient({ [method]: vi.fn().mockRejectedValue(forbidden) }));

    const result = await tools.get(tool)!(args);

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: `API key forbidden: check the key's scopes and account access (recommended scope: ${scope})`,
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
});
