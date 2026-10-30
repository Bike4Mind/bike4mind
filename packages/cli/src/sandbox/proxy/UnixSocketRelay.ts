/**
 * Host-side unix socket that forwards each connection to the filtering proxy's loopback port.
 * The Linux sandbox runs in a private network namespace, so this socket (bind-mounted into it,
 * see BubblewrapRuntime) is its only route out.
 */
import net from 'net';
import os from 'os';
import path from 'path';
import { mkdtempSync, rmSync } from 'fs';

export class UnixSocketRelay {
  private listening: { server: net.Server; socketPath: string; removeDirectory: () => void } | null = null;
  private activeSockets = new Set<net.Socket>();

  async start(targetPort: number): Promise<string> {
    if (this.listening) throw new Error('Proxy relay is already running');

    // mkdtemp creates the directory 0700, so other local users cannot reach the socket.
    const directory = mkdtempSync(path.join(os.tmpdir(), 'b4m-proxy-'));
    const socketPath = path.join(directory, 'proxy.sock');
    const removeDirectory = () => rmSync(directory, { recursive: true, force: true });
    const server = net.createServer(client => {
      const upstream = net.connect(targetPort, '127.0.0.1');
      for (const socket of [client, upstream]) {
        this.activeSockets.add(socket);
        socket.on('close', () => this.activeSockets.delete(socket));
      }
      client.on('error', () => upstream.destroy());
      upstream.on('error', () => client.destroy());
      client.pipe(upstream).pipe(client);
    });

    try {
      await new Promise<void>((resolve, reject) => {
        // Kept after listen too: an unhandled server 'error' would crash the CLI.
        server.on('error', reject);
        server.listen(socketPath, () => resolve());
      });
    } catch (error) {
      removeDirectory();
      throw error;
    }
    // A CLI that exits without stopping the proxy would otherwise leave the socket directory behind.
    process.once('exit', removeDirectory);
    this.listening = { server, socketPath, removeDirectory };
    return socketPath;
  }

  async stop(): Promise<void> {
    if (!this.listening) return;
    const { server, removeDirectory } = this.listening;
    this.listening = null;
    process.off('exit', removeDirectory);
    for (const socket of this.activeSockets) socket.destroy();
    this.activeSockets.clear();
    await new Promise<void>(resolve => server.close(() => resolve()));
    removeDirectory();
  }

  getSocketPath(): string | null {
    return this.listening?.socketPath ?? null;
  }
}
