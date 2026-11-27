import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

export interface RecordedRequest {
  method: string;
  path: string;
  body: string;
  headers: IncomingHttpHeaders;
}

export type Handler = (request: RecordedRequest, response: ServerResponse) => unknown;

export interface FakeServer {
  baseUrl: string;
  port: number;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

/**
 * Routes are keyed `'<METHOD> <path>'`, falling back to the path without its query string; anything else gets
 * Ollama's 404 shape.
 */
export async function startFakeServer(routes: Record<string, Handler>): Promise<FakeServer> {
  const requests: RecordedRequest[] = [];
  const sockets = new Set<Socket>();
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const request = {
      method: req.method ?? 'GET',
      path: req.url ?? '/',
      body: Buffer.concat(chunks).toString('utf8'),
      headers: req.headers,
    };
    requests.push(request);
    const handler =
      routes[`${request.method} ${request.path}`] ?? routes[`${request.method} ${request.path.split('?')[0]}`];
    if (!handler) return sendJson(res, { error: 'not found' }, 404);
    try {
      await handler(request, res);
    } catch (error) {
      // Surface the failure to the test's client instead of an unhandled rejection in the server.
      if (res.headersSent) res.destroy();
      else sendJson(res, { error: `fake handler threw: ${String(error)}` }, 500);
    }
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    requests,
    close: () =>
      new Promise<void>(resolve => {
        // Handlers that never answer keep sockets open; destroy them so close() resolves.
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

export function sendJson(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(typeof body === 'string' ? body : JSON.stringify(body));
}

export const json =
  (body: unknown, status = 200): Handler =>
  (_request, response) =>
    sendJson(response, body, status);

export const hang: Handler = () => undefined;

/** A port nothing listens on, so connecting to it is refused. */
export async function closedPort(): Promise<number> {
  const server = await startFakeServer({});
  await server.close();
  return server.port;
}

export const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
