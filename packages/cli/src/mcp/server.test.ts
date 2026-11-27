import { describe, it, expect, vi, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { LocalRuntime } from '@bike4mind/local-models';
import { B4mApiClient } from './b4mApiClient';
import { MODEL_TOOL_NAMES, type ModelToolsDeps } from './modelTools';
import { buildLocalMcpServer, buildMcpServer } from './server';
import { TOOL_NAMES, restrictToolsToKeyScopes } from './tools';

describe('buildLocalMcpServer', () => {
  it('serves callable model tools and no resources or prompts', async () => {
    const runtime = {
      id: 'ollama:127.0.0.1:11500',
      kind: 'ollama',
      baseUrl: 'http://127.0.0.1:11500',
      capabilities: { canPull: true, canRemove: true, canInspect: true, reportsLoaded: true },
      list: vi.fn().mockResolvedValue([
        {
          name: 'qwen2.5:0.5b',
          sizeBytes: 1,
          quantization: 'Q4_K_M',
          family: 'qwen2',
          parameterSize: '494M',
          modifiedAt: '2026-10-01T00:00:00Z',
          capabilities: { tools: true, vision: false, thinking: false, embeddings: false, completion: true },
        },
      ]),
      loaded: vi.fn().mockResolvedValue([]),
    } as unknown as LocalRuntime;
    const deps: ModelToolsDeps = {
      hub: vi.fn(),
      ollamaRegistry: vi.fn(),
      libraryLayers: vi.fn(),
      resolveRuntime: async () => ({ runtime, source: 'env' }),
      defaultModel: async () => undefined,
      machine: async () => ({ unknown: 'not read in this test' }),
    };
    const server = buildLocalMcpServer({ version: '0.0.0' }, deps);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const { tools } = await client.listTools();
    const result = await client.callTool({ name: 'models_list', arguments: {} });

    expect(tools.map(tool => tool.name)).toEqual([...MODEL_TOOL_NAMES]);
    expect(client.getServerCapabilities()).toEqual({ tools: { listChanged: true } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ models: [expect.objectContaining({ name: 'qwen2.5:0.5b' })] });
  });
});

describe('buildMcpServer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('serves the briefcase catalog over prompts/list', async () => {
    vi.spyOn(B4mApiClient.prototype, 'getBriefcaseCatalog').mockResolvedValue({
      general: [{ id: 'a'.repeat(24), name: 'Summarize' }],
    });
    const server = buildMcpServer({ baseURL: 'http://localhost:3000', apiKey: 'b4m_live_key', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const { prompts } = await client.listPrompts();

    expect(prompts.map(p => p.title)).toEqual(['Summarize']);
  });
});

describe('restrictToolsToKeyScopes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function listedTools(scopes: string[] | undefined | Error) {
    vi.spyOn(B4mApiClient.prototype, 'getOwnKeyScopes').mockImplementation(async () => {
      if (scopes instanceof Error) throw scopes;
      return scopes;
    });
    const client = new B4mApiClient('http://localhost:3000', undefined, 'b4m_live_key');
    const options = { baseURL: 'http://localhost:3000', apiKey: 'b4m_live_key', version: '0.0.0' };
    const server = buildMcpServer(options, client);
    await restrictToolsToKeyScopes(server, client);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: 'test-client', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);
    return (await mcpClient.listTools()).tools.map(t => t.name);
  }

  it('lists the function tools alone for a key that holds only functions:invoke', async () => {
    expect(await listedTools(['functions:invoke'])).toEqual(['list_functions', 'call_function']);
  });

  it('lists a tool for each scope the key holds', async () => {
    const names = await listedTools(['functions:invoke', 'notebooks:read']);
    expect(names).toEqual(expect.arrayContaining(['list_functions', 'call_function', 'list_notebooks']));
    expect(names).not.toContain('create_notebook');
  });

  it.each([
    ['notebooks:write', ['list_notebooks', 'get_notebook', 'search_knowledge_base']],
    ['datalake:query', ['list_lakes']],
    ['ai:generate', ['get_file', 'send_message']],
  ])('keeps the read tools listed for a key that holds only %s', async (scope, tools) => {
    expect(await listedTools([scope])).toEqual(expect.arrayContaining(tools));
  });

  it('hides the project read tools from a key that holds only projects:write', async () => {
    const names = await listedTools(['projects:write']);
    expect(names).not.toContain('list_projects');
    expect(names).not.toContain('get_project');
    expect(names).toContain('create_project');
  });

  it('hides publish_artifact from a key that holds only artifacts:publish', async () => {
    expect(await listedTools(['artifacts:publish'])).not.toContain('publish_artifact');
  });

  it.each([['notebooks:read'], ['notebooks:write']])(
    'lists publish_artifact for a key that holds artifacts:publish and %s',
    async scope => {
      expect(await listedTools(['artifacts:publish', scope])).toContain('publish_artifact');
    }
  );

  it.each([['files:write'], ['ai:generate']])('hides list_files from a key that holds only %s', async scope => {
    expect(await listedTools([scope])).not.toContain('list_files');
  });

  it('hides get_file from a key that holds only files:write', async () => {
    expect(await listedTools(['files:write'])).not.toContain('get_file');
  });

  it('lists only list_notebooks for a key that holds only admin:*', async () => {
    expect(await listedTools(['admin:*'])).toEqual(['list_notebooks']);
  });

  it('lists the file tools beside list_notebooks for an admin key that also holds files:read', async () => {
    expect((await listedTools(['admin:*', 'files:read'])).sort()).toEqual(['get_file', 'list_files', 'list_notebooks']);
  });

  it('lists publish_artifact for an admin key that also holds notebooks:read', async () => {
    expect(await listedTools(['admin:*', 'notebooks:read'])).toContain('publish_artifact');
  });

  it.each([
    ['scopes that cannot be read', undefined],
    ['an unidentified key', []],
    ['a failed lookup', new Error('offline')],
  ])('lists every tool for %s', async (_name, scopes) => {
    expect(await listedTools(scopes as string[] | undefined | Error)).toEqual(TOOL_NAMES);
  });
});
