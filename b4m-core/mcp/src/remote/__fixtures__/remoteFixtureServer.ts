/**
 * Test-only MCP fixture for `RemoteMcpClient`: the SDK's own server over Streamable HTTP and legacy SSE,
 * plus hostile routes (oversized, slow, endless, redirecting, auth-challenging). Listens on an ephemeral
 * 127.0.0.1 port; never imported by library code.
 */
import { randomUUID } from 'crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import type { AddressInfo, Socket } from 'net';
import { gzipSync } from 'zlib';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

export const FIXTURE_RESOURCE_METADATA_URL = 'https://auth.fixture.example/.well-known/oauth-protected-resource/mcp';
export const TEN_MB = 10 * 1024 * 1024;

export interface FixtureRequest {
  method: string;
  path: string;
  host: string;
  sessionId?: string;
}

export interface RemoteFixtureServer {
  port: number;
  /** Every request received, in order. */
  requests: FixtureRequest[];
  close(): Promise<void>;
}

function buildMcpServer(variant: 'basic' | 'many'): McpServer {
  const server = new McpServer({ name: 'fixture', version: '1.0.0' });
  if (variant === 'many') {
    const wide: Record<string, z.ZodString> = {};
    for (let i = 0; i < 200; i++) wide[`field_${i}`] = z.string().describe('x'.repeat(100));
    server.registerTool('huge_schema', { description: 'Schema over 16KB', inputSchema: wide }, async () => ({
      content: [],
    }));
    server.registerTool('long_description', { description: 'd'.repeat(5000) }, async () => ({ content: [] }));
    for (let i = 0; i < 120; i++) {
      server.registerTool(`tool_${i}`, { description: `Tool ${i}` }, async () => ({ content: [] }));
    }
    return server;
  }
  server.registerTool(
    'echo',
    {
      description: 'Echoes the input',
      inputSchema: { text: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ text }) => ({ content: [{ type: 'text', text: `echo: ${text}` }] })
  );
  server.registerTool('fail', { description: 'Always reports a tool error' }, async () => ({
    content: [{ type: 'text', text: 'nope' }],
    isError: true,
  }));
  server.registerTool('hang', { description: 'Never completes' }, () => new Promise(() => undefined));
  return server;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : undefined;
}

function streamForever(res: ServerResponse, contentType: string): void {
  res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-cache' });
  const timer = setInterval(() => res.write(': ping\n\n'), 20);
  res.on('close', () => clearInterval(timer));
}

/** Starts the fixture on 127.0.0.1 with an ephemeral port. */
export async function startRemoteFixtureServer(): Promise<RemoteFixtureServer> {
  const requests: FixtureRequest[] = [];
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const legacySessions = new Map<string, SSEServerTransport>();
  const sockets = new Set<Socket>();
  let port = 0;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://fixture');
    const path = url.pathname;
    const sessionHeader = req.headers['mcp-session-id'];
    const sessionId = typeof sessionHeader === 'string' ? sessionHeader : undefined;
    requests.push({ method: req.method ?? '', path, host: req.headers.host ?? '', sessionId });

    switch (path) {
      case '/mcp': {
        const existing = sessionId ? sessions.get(sessionId) : undefined;
        if (existing) {
          await existing.handleRequest(req, res, req.method === 'POST' ? await readJson(req) : undefined);
          return;
        }
        if (req.method !== 'POST') {
          res.writeHead(sessionId ? 404 : 400).end();
          return;
        }
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: id => {
            sessions.set(id, transport);
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        await buildMcpServer('basic').connect(transport);
        await transport.handleRequest(req, res, await readJson(req));
        return;
      }
      case '/many': {
        // Stateless: a fresh server and transport per request, no session id.
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await buildMcpServer('many').connect(transport);
        await transport.handleRequest(req, res, req.method === 'POST' ? await readJson(req) : undefined);
        return;
      }
      case '/legacy': {
        if (req.method !== 'GET') {
          res.writeHead(405).end();
          return;
        }
        const transport = new SSEServerTransport('/legacy/messages', res);
        legacySessions.set(transport.sessionId, transport);
        res.on('close', () => legacySessions.delete(transport.sessionId));
        await buildMcpServer('basic').connect(transport);
        return;
      }
      case '/legacy/messages': {
        const transport = legacySessions.get(url.searchParams.get('sessionId') ?? '');
        if (!transport) {
          res.writeHead(404).end();
          return;
        }
        await transport.handlePostMessage(req, res, await readJson(req));
        return;
      }
      case '/legacy-silent':
        if (req.method !== 'GET') {
          res.writeHead(405).end();
          return;
        }
        streamForever(res, 'text/event-stream');
        return;
      case '/big': {
        res.writeHead(200, { 'content-type': 'application/json' });
        const chunk = Buffer.alloc(64 * 1024, 0x20);
        let sent = 0;
        const pump = (): void => {
          while (sent < TEN_MB) {
            sent += chunk.length;
            if (!res.write(chunk)) {
              res.once('drain', pump);
              return;
            }
          }
          res.end();
        };
        pump();
        return;
      }
      case '/gzip-bomb': {
        const compressed = gzipSync(Buffer.alloc(TEN_MB, 0x20));
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-encoding': 'gzip',
          'content-length': String(compressed.length),
        });
        res.end(compressed);
        return;
      }
      case '/slow':
        // Never answers; the socket is destroyed on close.
        return;
      case '/stream-forever':
        streamForever(res, 'text/event-stream');
        return;
      case '/unauthorized':
        res
          .writeHead(401, {
            'www-authenticate': `Bearer resource_metadata="${FIXTURE_RESOURCE_METADATA_URL}", scope="tools.read"`,
          })
          .end();
        return;
      case '/forbidden':
        res.writeHead(403).end();
        return;
      case '/broken':
        res.writeHead(502).end();
        return;
      case '/redirect-metadata':
        res.writeHead(307, { location: 'http://169.254.169.254/latest/meta-data/' }).end();
        return;
      case '/redirect-cross':
        res.writeHead(307, { location: `http://other.fixture.test:${port}/mcp` }).end();
        return;
      case '/redirect-same':
        res.writeHead(307, { location: '/mcp' }).end();
        return;
      case '/redirect-loop':
        res.writeHead(307, { location: '/redirect-loop' }).end();
        return;
      default:
        res.writeHead(404).end();
    }
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;

  return {
    port,
    requests,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
