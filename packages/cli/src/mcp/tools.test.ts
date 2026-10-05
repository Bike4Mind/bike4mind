import { describe, it, expect, vi } from 'vitest';
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
          description: null,
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
          description: undefined,
          built_in: false,
          status: 'ready',
          file_count: 3,
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
      { id: 'fab1', type: 'document', title: 'Handbook.pdf', url: undefined, description: 'p. 3' },
    ]);
  });

  it('send_message still returns the reply with empty citables when the quest fetch fails', async () => {
    const client = mockClient({
      sendChat: vi
        .fn()
        .mockResolvedValue({ id: 'q1', status: 'done', response: null, responses: ['hello'], model: 'gpt' }),
      getQuest: vi.fn().mockRejectedValue(new Error('boom')),
    });

    const result = await sendMessage(client, { message: 'hi', notebookId: 'nb1' });

    expect(result).toEqual({ notebookId: 'nb1', questId: 'q1', reply: 'hello', model: 'gpt', citables: [] });
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
        audio: Buffer.from('abc'),
        contentType: 'audio/mpeg',
        saved: true,
        fabFileId: 'fab1',
        fileName: 'sound-effect.mp3',
        fileUrl: 'https://signed',
      }),
      getFile,
    });

    const result = await generateSoundEffect(client, { text: 'thunder', provider: 'elevenlabs' });

    // The URL comes off the response header, so no GET /api/files/:id round-trip is
    // made - that re-fetch would fail closed until the async moderation scan runs.
    expect(getFile).not.toHaveBeenCalled();
    expect(result).toEqual({
      saved: true,
      provider: 'elevenlabs',
      contentType: 'audio/mpeg',
      byteLength: 3,
      file: { id: 'fab1', fileName: 'sound-effect.mp3', fileUrl: 'https://signed' },
    });
  });

  it('generate_sound_effect falls back to inline audio when a save yields no usable URL', async () => {
    const client = mockClient({
      generateSoundEffect: vi
        .fn()
        .mockResolvedValue({ audio: Buffer.from('abc'), contentType: 'audio/mpeg', saved: true, fabFileId: 'fab1' }),
    });

    const result = await generateSoundEffect(client, { text: 'thunder', provider: 'elevenlabs' });

    // Persisted but no fileUrl: hand back the bytes the caller was already billed for.
    expect(result).toEqual({
      saved: false,
      provider: 'elevenlabs',
      contentType: 'audio/mpeg',
      byteLength: 3,
      audioBase64: Buffer.from('abc').toString('base64'),
    });
  });

  it('generate_sound_effect returns the audio inline (base64) when it was not persisted', async () => {
    const client = mockClient({
      generateSoundEffect: vi
        .fn()
        .mockResolvedValue({ audio: Buffer.from('abc'), contentType: 'audio/mpeg', saved: false }),
    });

    const result = await generateSoundEffect(client, { text: 'thunder', provider: 'elevenlabs' });

    expect(result).toEqual({
      saved: false,
      provider: 'elevenlabs',
      contentType: 'audio/mpeg',
      byteLength: 3,
      audioBase64: Buffer.from('abc').toString('base64'),
    });
  });
});

describe('registerTools', () => {
  const collectTools = (client: B4mApiClient) => {
    const tools = new Map<string, (args: unknown) => Promise<CallToolResult>>();
    const server = {
      registerTool: (name: string, _config: unknown, cb: (args: unknown) => Promise<CallToolResult>) => {
        tools.set(name, cb);
      },
    } as unknown as McpServer;
    registerTools(server, client);
    return tools;
  };

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
          audio: Buffer.from('abc'),
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
        generateSoundEffect: vi
          .fn()
          .mockResolvedValue({ audio: Buffer.from('abc'), contentType: 'audio/mpeg', saved: false }),
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
});
