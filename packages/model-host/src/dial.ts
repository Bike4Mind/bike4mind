import { request } from 'node:http';
import { createConnection, type Socket } from 'node:net';
import { userInfo } from 'node:os';
import { ModelHostHelloSchema, type ModelHostHello } from '@bike4mind/common/modelHub';

/** Exit codes a client acts on: Desktop maps them to "start the service" and "add yourself to the group". */
export const EXIT_NOT_RUNNING = 3;
export const EXIT_NO_ACCESS = 4;

export type DialFailure = 'not-running' | 'no-access' | 'error';

export type DialResult =
  | { ok: true; socket: Socket; path: string }
  | { ok: false; failure: DialFailure; path: string | null; message: string };

function connectOnce(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path });
    socket.once('connect', () => {
      socket.off('error', reject);
      resolve(socket);
    });
    socket.once('error', reject);
  });
}

/** Connects to the first socket that accepts; otherwise says whether the host is down or out of reach. */
export async function dialFirst(candidates: readonly string[]): Promise<DialResult> {
  let refused: string | null = null;
  let denied: string | null = null;
  let other: { path: string; message: string } | null = null;
  for (const path of candidates) {
    try {
      return { ok: true, socket: await connectOnce(path), path };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ECONNREFUSED') refused ??= path;
      else if (code === 'EACCES' || code === 'EPERM') denied ??= path;
      else if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        other ??= { path, message: error instanceof Error ? error.message : String(error) };
      }
    }
  }
  // A socket nobody answers on means a stopped service even when another one is out of reach.
  if (refused) return { ok: false, failure: 'not-running', path: refused, message: notRunningMessage() };
  if (denied) return { ok: false, failure: 'no-access', path: denied, message: noAccessMessage(denied) };
  if (other) return { ok: false, failure: 'error', path: other.path, message: other.message };
  return { ok: false, failure: 'not-running', path: null, message: notRunningMessage() };
}

export function login(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER ?? `uid${process.getuid?.() ?? ''}`;
  }
}

function notRunningMessage(): string {
  return (
    'b4m-host is not running. Start it with: sudo systemctl start b4m-host ' +
    '(for a user install: systemctl --user start b4m-host)'
  );
}

function noAccessMessage(path: string): string {
  return (
    `No permission to use ${path}. Ask an administrator to run: sudo usermod -aG b4m-host ${login()} ` +
    '(then sign in again so the new group applies)'
  );
}

export function exitCodeFor(failure: DialFailure): number {
  if (failure === 'not-running') return EXIT_NOT_RUNNING;
  if (failure === 'no-access') return EXIT_NO_ACCESS;
  return 1;
}

export interface DialStdioOptions {
  candidates: readonly string[];
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

/** Bridges stdin and stdout to the host's socket, after one preamble line naming the caller. */
export async function dialStdio(options: DialStdioOptions): Promise<number> {
  const dialed = await dialFirst(options.candidates);
  if (!dialed.ok) {
    options.stderr.write(`b4m-host: ${dialed.message}\n`);
    return exitCodeFor(dialed.failure);
  }
  const { socket } = dialed;
  const label = login()
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 64);
  socket.write(`B4M-DIAL 1 user=${label} uid=${process.getuid?.() ?? -1}\n`);
  return new Promise(resolve => {
    let failed = false;
    let received = false;
    socket.on('error', error => {
      failed = true;
      options.stderr.write(`b4m-host: ${error.message}\n`);
      socket.destroy();
    });
    options.stdout.on('error', () => {
      failed = true;
      socket.destroy();
    });
    socket.on('data', () => (received = true));
    options.stdin.pipe(socket);
    socket.pipe(options.stdout, { end: false });
    // The host closing (keep-alive timeout, shutdown) ends the bridge even while stdin stays open.
    socket.on('end', () => {
      options.stdin.unpipe(socket);
      socket.end();
    });
    socket.on('close', () => {
      options.stdin.unpipe(socket);
      if (!received && !failed) {
        failed = true;
        options.stderr.write('b4m-host: the host closed the connection\n');
      }
      options.stdout.write('', () => resolve(failed ? 1 : 0));
    });
  });
}

/** `GET /v1/hello` on one socket. */
export function fetchHello(path: string, timeoutMs = 10_000): Promise<ModelHostHello> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: path, path: '/v1/hello', method: 'GET', timeout: timeoutMs }, res => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 64 * 1024) req.destroy(new Error('hello response too large'));
        else chunks.push(chunk);
      });
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) throw new Error(`hello returned HTTP ${res.statusCode}`);
          resolve(ModelHostHelloSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('hello timed out')));
    req.on('error', reject);
    req.end();
  });
}
