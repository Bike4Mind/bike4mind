import { chmod, unlink } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { ensurePrivateDirectory } from '../auth/privateDirectory';
import type { HeadlessHost } from './composeHeadlessHost';
import { acquireDaemonLock, daemonPaths, socketAccepts, type DaemonPaths } from './daemonFiles';
import type { HostLogger } from './logging';
import { serveHostSocket, type ServeSocketOptions } from './socketTransport';

const OWNER_ONLY_SOCKET = 0o600;

export type DaemonOptions = {
  dataDirectory: string;
  version: string;
  logger: HostLogger;
  /** Builds the host once the lock is held and the socket is listening. */
  compose(): Promise<HeadlessHost>;
  socket?: ServeSocketOptions;
};

export type RunningDaemon = {
  readonly paths: DaemonPaths;
  readonly host: HeadlessHost;
  /** Stops accepting, drops every client, disposes the host and removes the socket and the lock. */
  close(): Promise<void>;
};

/**
 * The per-user daemon: owns one host and serves it on a unix socket in the data directory to
 * any number of clients at once. It keeps running when the last client leaves, which is what
 * lets a turn outlive the connection that started it. Throws DaemonAlreadyRunningError when
 * another daemon holds the lock.
 */
export async function startDaemon(options: DaemonOptions): Promise<RunningDaemon> {
  const { dataDirectory, version, logger } = options;
  await ensurePrivateDirectory(dataDirectory);
  const paths = daemonPaths(dataDirectory);
  const lock = await acquireDaemonLock(paths, version);

  const sockets = new Set<Socket>();
  let server: Server | null = null;
  try {
    await clearStaleSocket(paths);
    // Clients connect before the host is built and are served once it is: the socket answering
    // early is how another starter sees this daemon as live rather than stale.
    let ready: HeadlessHost | null = null;
    const waiting: Socket[] = [];
    server = createServer({ allowHalfOpen: true }, socket => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      if (ready) serveHostSocket(socket, ready.server, logger, options.socket);
      else waiting.push(socket);
    });
    await listen(server, paths.socket);
    server.on('error', err => logger.error('HOST: socket server error', err));
    const host = await options.compose();
    ready = host;
    for (const socket of waiting.splice(0)) {
      if (!socket.destroyed) serveHostSocket(socket, host.server, logger, options.socket);
    }
    logger.warn(`HOST: daemon ${version} (pid ${process.pid}) serving ${paths.socket}`);

    const listening = server;
    let closing: Promise<void> | null = null;
    return {
      paths,
      host,
      close: () => {
        closing ??= (async () => {
          logger.warn('HOST: daemon stopping');
          const stopped = new Promise<void>(resolve => listening.close(() => resolve()));
          for (const socket of sockets) socket.destroy();
          await stopped;
          host.dispose();
          await removeSocket(paths);
          await lock.release();
        })();
        return closing;
      },
    };
  } catch (err) {
    for (const socket of sockets) socket.destroy();
    if (server?.listening) {
      const stopping = server;
      await new Promise<void>(resolve => stopping.close(() => resolve()));
      await removeSocket(paths);
    }
    await lock.release();
    throw err;
  }
}

/** Under the lock any socket file is a dead daemon's, unless something still answers on it. */
async function clearStaleSocket(paths: DaemonPaths): Promise<void> {
  if (await socketAccepts(paths.socket)) {
    throw new Error(`Something is already listening on ${paths.socket} without holding ${paths.lock}`);
  }
  await removeSocket(paths);
}

async function removeSocket(paths: DaemonPaths): Promise<void> {
  try {
    await unlink(paths.socket);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/** Created owner-only from the start: the umask covers the moment between bind and chmod. */
async function listen(server: Server, path: string): Promise<void> {
  const previous = process.umask(0o177);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } finally {
    process.umask(previous);
  }
  await chmod(path, OWNER_ONLY_SOCKET);
}
