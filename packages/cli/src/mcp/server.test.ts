import { describe, it, expect, vi, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { B4mApiClient } from './b4mApiClient';
import { buildMcpServer } from './server';

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
