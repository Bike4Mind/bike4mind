import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, statSync } from 'fs';
import net from 'net';
import path from 'path';
import { UnixSocketRelay } from './UnixSocketRelay.js';

/** Loopback server that echoes back whatever it receives, prefixed. */
async function startEchoServer(): Promise<net.Server> {
  const server = net.createServer(socket => socket.on('data', chunk => socket.write(`echo:${chunk}`)));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
}

const portOf = (server: net.Server) => (server.address() as net.AddressInfo).port;

describe('UnixSocketRelay', () => {
  let relay: UnixSocketRelay;
  const servers: net.Server[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await relay?.stop();
    for (const server of servers.splice(0)) server.close();
  });

  it('forwards unix socket traffic to the loopback port', async () => {
    const target = await startEchoServer();
    servers.push(target);
    relay = new UnixSocketRelay();
    const socketPath = await relay.start(portOf(target));

    const reply = await new Promise<string>((resolve, reject) => {
      const client = net.connect(socketPath, () => client.write('ping'));
      client.on('data', chunk => {
        resolve(chunk.toString());
        client.end();
      });
      client.on('error', reject);
    });

    expect(reply).toBe('echo:ping');
    expect(relay.getSocketPath()).toBe(socketPath);
  });

  it('keeps the socket in a directory only the owner can enter', async () => {
    relay = new UnixSocketRelay();
    const socketPath = await relay.start(1);
    expect(statSync(path.dirname(socketPath)).mode & 0o777).toBe(0o700);
  });

  it('closes the client when the target port refuses the connection', async () => {
    const closed = await startEchoServer();
    const port = portOf(closed);
    await new Promise<void>(resolve => closed.close(() => resolve()));
    relay = new UnixSocketRelay();
    const socketPath = await relay.start(port);

    await new Promise<void>((resolve, reject) => {
      const client = net.connect(socketPath);
      client.on('close', () => resolve());
      client.on('error', reject);
    });
  });

  it('closes the upstream connection when the client fails', async () => {
    let upstreamClosed!: () => void;
    const upstreamDone = new Promise<void>(resolve => (upstreamClosed = resolve));
    const target = net.createServer(socket => socket.on('close', () => upstreamClosed()));
    await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
    servers.push(target);
    const createServer = net.createServer;
    let relayServer!: net.Server;
    vi.spyOn(net, 'createServer').mockImplementation(((listener: (socket: net.Socket) => void) => {
      relayServer = createServer(listener);
      return relayServer;
    }) as typeof net.createServer);
    relay = new UnixSocketRelay();
    const socketPath = await relay.start(portOf(target));

    const accepted = new Promise<void>(resolve => target.once('connection', () => resolve()));
    relayServer.once('connection', socket => accepted.then(() => socket.emit('error', new Error('reset'))));
    net.connect(socketPath).on('error', () => {});
    await upstreamDone;
  });

  it('destroys open connections and removes the socket on stop', async () => {
    const target = await startEchoServer();
    servers.push(target);
    relay = new UnixSocketRelay();
    const socketPath = await relay.start(portOf(target));
    const client = net.connect(socketPath);
    const clientClosed = new Promise<void>(resolve => client.on('close', () => resolve()));
    await new Promise<void>(resolve => client.on('connect', () => resolve()));

    await relay.stop();

    await clientClosed;
    expect(existsSync(socketPath)).toBe(false);
    expect(existsSync(path.dirname(socketPath))).toBe(false);
    expect(relay.getSocketPath()).toBeNull();
  });

  it('removes the socket directory when the process exits without a stop', async () => {
    const before = process.listeners('exit');
    relay = new UnixSocketRelay();
    const socketPath = await relay.start(1);
    const added = process.listeners('exit').filter(listener => !before.includes(listener));
    expect(added).toHaveLength(1);

    added[0](0);

    expect(existsSync(path.dirname(socketPath))).toBe(false);
    await relay.stop();
    expect(process.listeners('exit')).toEqual(before);
  });

  it('keeps running when the server reports an error after listening', async () => {
    const createServer = net.createServer;
    let relayServer!: net.Server;
    vi.spyOn(net, 'createServer').mockImplementation(((listener: (socket: net.Socket) => void) => {
      relayServer = createServer(listener);
      return relayServer;
    }) as typeof net.createServer);
    relay = new UnixSocketRelay();
    const socketPath = await relay.start(1);

    expect(() => relayServer.emit('error', new Error('EMFILE'))).not.toThrow();
    expect(relay.getSocketPath()).toBe(socketPath);
  });

  it('stop is a no-op when not started', async () => {
    relay = new UnixSocketRelay();
    await expect(relay.stop()).resolves.toBeUndefined();
    expect(relay.getSocketPath()).toBeNull();
  });

  it('refuses to start twice', async () => {
    relay = new UnixSocketRelay();
    await relay.start(1);
    await expect(relay.start(1)).rejects.toThrow('Proxy relay is already running');
  });

  it('removes its directory and rethrows when listening fails', async () => {
    let directory = '';
    vi.spyOn(net.Server.prototype, 'listen').mockImplementation(function (this: net.Server, socketPath: unknown) {
      directory = path.dirname(String(socketPath));
      process.nextTick(() => this.emit('error', new Error('listen failed')));
      return this;
    } as typeof net.Server.prototype.listen);
    relay = new UnixSocketRelay();

    await expect(relay.start(1)).rejects.toThrow('listen failed');
    expect(existsSync(directory)).toBe(false);
    expect(relay.getSocketPath()).toBeNull();
  });
});
