import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { checkToolDesign } from './designRules';
import { ALL_TOOLS, registerBike4MindTools, selectTools } from './register';
import { makeCtx } from './testUtils';

describe('every registered tool obeys the design rules', () => {
  const ctx = makeCtx();
  const tools = selectTools(ctx);

  it('registers every shipped tool when nothing is filtered', () => {
    expect(tools.map(t => t.name)).toEqual(ALL_TOOLS.map(t => t.name).sort());
    expect(new Set(tools.map(t => t.name)).size).toBe(tools.length);
  });

  it('has no violations', () => {
    expect(tools.flatMap(checkToolDesign)).toEqual([]);
  });

  it('lists identical names and descriptions, in the same order, from two servers', async () => {
    const list = async () => {
      const server = new McpServer({ name: 'test', version: '0.0.0' });
      registerBike4MindTools(server, ctx);
      const client = new Client({ name: 'c', version: '0.0.0' });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(a), client.connect(b)]);
      return JSON.stringify((await client.listTools()).tools);
    };
    expect(await list()).toBe(await list());
  });
});
