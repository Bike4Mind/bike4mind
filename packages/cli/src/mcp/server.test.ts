import { describe, it, expect, vi, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { LocalRuntime } from '@bike4mind/local-models';
import { B4mApiClient } from './b4mApiClient';
import { MODEL_TOOL_NAMES, type ModelToolsDeps } from './modelTools';
import { buildLocalMcpServer, buildMcpServer } from './server';

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
      resolveRuntime: async () => ({ runtime, source: 'env' }),
      defaultModel: async () => undefined,
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
