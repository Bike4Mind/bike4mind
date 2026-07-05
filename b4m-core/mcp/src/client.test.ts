import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { MCPClient } from './client';

/**
 * AC#6 - streamable-HTTP MCP transport.
 *
 * Spins up an in-process streamable-HTTP MCP server (stateless mode), connects
 * `MCPClient` over HTTP with a Bearer token, and asserts:
 *  - every HTTP request carries `Authorization: Bearer <tok>`
 *  - tools list over HTTP
 *  - a tool call round-trips over HTTP
 */
describe('MCPClient (streamable-HTTP transport)', () => {
  let httpServer: Server | undefined;

  afterEach(async () => {
    if (httpServer) {
      await new Promise<void>(resolve => httpServer!.close(() => resolve()));
      httpServer = undefined;
    }
  });

  /** Start a stateless streamable-HTTP MCP server exposing a single `echo` tool. */
  async function startServer(authHeaders: (string | undefined)[]): Promise<string> {
    httpServer = createServer(async (req, res) => {
      // Record the Authorization header on every request (the assertion target).
      authHeaders.push(req.headers['authorization']);

      // Stateless: fresh server + transport per request.
      const server = new McpServer({ name: 'test-server', version: '1.0.0' });
      server.registerTool(
        'echo',
        { description: 'Echoes its input', inputSchema: { msg: z.string() } },
        async ({ msg }) => ({ content: [{ type: 'text', text: `echo:${msg}` }] })
      );

      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    });

    await new Promise<void>(resolve => httpServer!.listen(0, '127.0.0.1', () => resolve()));
    const { port } = httpServer!.address() as AddressInfo;
    return `http://127.0.0.1:${port}/mcp`;
  }

  it('connects over HTTP, sends Bearer token on every request, lists and calls a tool', async () => {
    const authHeaders: (string | undefined)[] = [];
    const url = await startServer(authHeaders);
    const token = 'test-token-abc123';

    const client = new MCPClient({
      envVariables: [],
      name: 'host',
      url,
      headers: { Authorization: `Bearer ${token}` },
    });

    await client.connectToServer();

    // Tools listed over HTTP.
    expect(client.tools.map(t => t.name)).toContain('echo');

    // Tool call round-trips over HTTP.
    const result = (await client.callTool('echo', { msg: 'hi' })) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(result.content[0].text).toBe('echo:hi');

    await client.disconnect();

    // Every request carried the Bearer token.
    expect(authHeaders.length).toBeGreaterThan(0);
    for (const h of authHeaders) {
      expect(h).toBe(`Bearer ${token}`);
    }
  });
});
