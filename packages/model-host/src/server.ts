import { chmod, chown, rm } from 'node:fs/promises';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';
import type { ModelHostError, ModelHostRole } from '@bike4mind/common/modelHub';
import { MAX_SOCKET_PATH_BYTES } from './paths';
import { TokenBucket } from './rateLimit';

export interface ServerLimits {
  bodyBytes: number;
  headerBytes: number;
  preambleBytes: number;
  /** A connection that sends nothing for this long is closed (ms). */
  firstByteTimeoutMs: number;
  /** An idle connection is closed after this long; event streams write more often (ms). */
  idleTimeoutMs: number;
  /** A kept-alive connection with no next request is closed after this long (ms). */
  keepAliveTimeoutMs: number;
  /** Per socket. */
  maxConnections: number;
  /** Per socket, shared by every connection on it. */
  rateBurst: number;
  ratePerSecond: number;
}

export const DEFAULT_LIMITS: ServerLimits = {
  bodyBytes: 64 * 1024,
  headerBytes: 16 * 1024,
  preambleBytes: 256,
  firstByteTimeoutMs: 10_000,
  idleTimeoutMs: 30_000,
  keepAliveTimeoutMs: 5_000,
  maxConnections: 64,
  rateBurst: 120,
  ratePerSecond: 20,
};

/** `login` is what `dial-stdio`'s preamble reported: a label, never an identity. */
export interface Connection {
  role: ModelHostRole;
  login: string | null;
}

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  conn: Connection;
  body: Buffer;
}

export type RequestHandler = (ctx: RequestContext) => Promise<void> | void;

export interface ListenerSpec {
  role: ModelHostRole;
  path: string;
  /** Final file mode of the socket; it is the authorization. */
  mode: number;
  gid: number | null;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {}
  ) {
    super(message);
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(text);
}

export function sendError(res: ServerResponse, error: HttpError) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body: ModelHostError = { code: error.code, message: error.message };
  sendJson(res, error.status, body, error.headers);
}

const PREAMBLE_PREFIX = Buffer.from('B4M-DIAL ');

/** The login from `B4M-DIAL 1 user=<login> uid=<uid>`, when it is a plain account name. */
export function parsePreamble(line: string): string | null {
  const match = /^B4M-DIAL 1(?: .*)?$/.exec(line);
  if (!match) return null;
  return /(?:^| )user=([A-Za-z0-9._-]{1,64})(?: |$)/.exec(line)?.[1] ?? null;
}

type Preamble = { login: string | null; rest: Buffer };

/** Reads an optional preamble line; anything else is handed back untouched for the HTTP parser. */
function readPreamble(socket: Socket, limits: ServerLimits): Promise<Preamble | null> {
  return new Promise(resolve => {
    let buffered = Buffer.alloc(0);
    const finish = (result: Preamble | null) => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('close', onClose);
      socket.pause();
      resolve(result);
    };
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const n = Math.min(buffered.length, PREAMBLE_PREFIX.length);
      if (!buffered.subarray(0, n).equals(PREAMBLE_PREFIX.subarray(0, n)))
        return finish({ login: null, rest: buffered });
      if (buffered.length < PREAMBLE_PREFIX.length) return;
      const newline = buffered.indexOf(0x0a);
      if (newline === -1 ? buffered.length > limits.preambleBytes : newline > limits.preambleBytes) return finish(null);
      if (newline === -1) return;
      const line = buffered.subarray(0, newline).toString('latin1').replace(/\r$/, '');
      finish({ login: parsePreamble(line), rest: buffered.subarray(newline + 1) });
    };
    const onClose = () => finish(null);
    const timer = setTimeout(() => finish(null), limits.firstByteTimeoutMs);
    socket.on('data', onData);
    socket.on('close', onClose);
    socket.resume();
  });
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const tooLarge = () =>
    new HttpError(413, 'body-too-large', `Request bodies are limited to ${limit} bytes.`, { connection: 'close' });
  return new Promise((resolve, reject) => {
    const declared = req.headers['content-length'];
    if (declared !== undefined && Number(declared) > limit) return reject(tooLarge());
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        cleanup();
        req.pause();
        reject(tooLarge());
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

interface Listener {
  spec: ListenerSpec;
  server: NetServer;
  bucket: TokenBucket;
}

/** HTTP over Unix sockets, one per role: a connection's role is the socket it came in on. */
export class HostServer {
  readonly limits: ServerLimits;
  #http: HttpServer;
  #listeners: Listener[] = [];
  #connections = new WeakMap<Socket, Connection & { bucket: TokenBucket }>();
  #sockets = new Set<Socket>();

  constructor(
    private readonly handler: RequestHandler,
    limits: Partial<ServerLimits> = {},
    private readonly log: (line: string) => void = () => {}
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.#http = createHttpServer(
      { maxHeaderSize: this.limits.headerBytes },
      (req, res) => void this.#request(req, res)
    );
    this.#http.timeout = this.limits.idleTimeoutMs;
    this.#http.keepAliveTimeout = this.limits.keepAliveTimeoutMs;
    // dial-stdio passes on stdin's EOF before the reply exists; without this Node ends the socket at once.
    Object.assign(this.#http, { httpAllowHalfOpen: true });
  }

  get listeners(): ListenerSpec[] {
    return this.#listeners.map(listener => listener.spec);
  }

  async #request(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const conn = this.#connections.get(req.socket);
    try {
      if (!conn) throw new HttpError(500, 'internal', 'Unknown connection.');
      if (!conn.bucket.take()) {
        throw new HttpError(429, 'rate-limited', 'Too many requests; try again shortly.', {
          'retry-after': String(conn.bucket.retryAfterSeconds()),
        });
      }
      const body = await readBody(req, this.limits.bodyBytes);
      await this.handler({ req, res, conn: { role: conn.role, login: conn.login }, body });
    } catch (error) {
      if (error instanceof HttpError) {
        sendError(res, error);
        return;
      }
      this.log(`request failed: ${error instanceof Error ? error.message : String(error)}`);
      sendError(res, new HttpError(500, 'internal', 'Internal error.'));
    }
  }

  async #accept(socket: Socket, listener: Listener): Promise<void> {
    this.#sockets.add(socket);
    socket.on('close', () => this.#sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    const preamble = await readPreamble(socket, this.limits);
    if (!preamble) {
      socket.destroy();
      return;
    }
    this.#connections.set(socket, { role: listener.spec.role, login: preamble.login, bucket: listener.bucket });
    if (preamble.rest.length) socket.unshift(preamble.rest);
    this.#http.emit('connection', socket);
    socket.resume();
  }

  /** Creates the socket with no access beyond its owner until its group and mode are set. */
  async listen(spec: ListenerSpec): Promise<void> {
    if (Buffer.byteLength(spec.path) > MAX_SOCKET_PATH_BYTES) {
      throw new Error(`Socket path is longer than ${MAX_SOCKET_PATH_BYTES} bytes: ${spec.path}`);
    }
    const server = createNetServer({ allowHalfOpen: true, pauseOnConnect: true });
    server.maxConnections = this.limits.maxConnections;
    const listener: Listener = {
      spec,
      server,
      bucket: new TokenBucket(this.limits.rateBurst, this.limits.ratePerSecond),
    };
    server.on('connection', socket => void this.#accept(socket, listener));
    const previous = process.umask(0o177);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(spec.path, () => {
          server.off('error', reject);
          resolve();
        });
      });
    } finally {
      process.umask(previous);
    }
    try {
      if (spec.gid !== null) await chown(spec.path, -1, spec.gid);
      await chmod(spec.path, spec.mode);
    } catch (error) {
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(spec.path, { force: true });
      throw error;
    }
    server.on('error', error => this.log(`socket ${spec.path}: ${error.message}`));
    this.#listeners.push(listener);
  }

  /** Closing a listener also removes its socket file. */
  async close(): Promise<void> {
    const closed = this.#listeners
      .splice(0)
      .map(({ server }) => new Promise<void>(resolve => server.close(() => resolve())));
    for (const socket of this.#sockets) socket.destroy();
    this.#http.closeAllConnections();
    await Promise.all(closed);
  }
}
