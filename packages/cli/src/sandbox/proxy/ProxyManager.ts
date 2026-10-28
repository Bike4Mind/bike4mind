/**
 * ProxyManager - lifecycle manager for the HTTP CONNECT proxy.
 *
 * Single interface for the rest of the system: start, stop, get env vars,
 * manage domains, subscribe to events.
 */
import { mkdtempSync, rmSync } from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import type { NetworkConfig } from '../types.js';
import { HttpConnectProxy, type ProxyEvent } from './HttpConnectProxy.js';

export interface ProxyManagerOptions {
  /** Also expose the proxy on a Unix socket, for sandboxes with their own network namespace. */
  unixSocketBridge?: boolean;
}

export class ProxyManager {
  private proxy: HttpConnectProxy | null = null;
  private networkConfig: NetworkConfig;
  private eventHandlers = new Set<(event: ProxyEvent) => void>();
  private startPromise: Promise<void> | null = null;
  private readonly unixSocketBridge: boolean;
  private bridge: UnixSocketBridge | null = null;

  constructor(networkConfig: NetworkConfig, options: ProxyManagerOptions = {}) {
    this.networkConfig = { ...networkConfig, allowedDomains: [...networkConfig.allowedDomains] };
    this.unixSocketBridge = options.unixSocketBridge === true;
  }

  /**
   * Update the live enabled flag so a runtime toggle takes effect on the next
   * start()/stop(). Without this, start() would early-return on the enabled value
   * snapshotted at construction and grant egress with no proxy actually running.
   */
  setEnabled(enabled: boolean): void {
    this.networkConfig.enabled = enabled;
  }

  // Not async on purpose: an async method wraps its return value in a fresh
  // promise, so concurrent callers could never share ONE in-flight start. Returning
  // the stored promise directly is what lets the guard below dedupe overlapping
  // starts - isRunning() alone does not (both see it false before either server
  // binds), which would leak an orphaned listening proxy.
  start(): Promise<void> {
    if (!this.networkConfig.enabled) return Promise.resolve();
    if (this.proxy?.isRunning()) return Promise.resolve(); // idempotent
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.doStart().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    this.proxy = new HttpConnectProxy({
      allowedDomains: this.networkConfig.allowedDomains,
    });

    // Forward events
    this.proxy.on('proxy-event', (event: ProxyEvent) => {
      for (const handler of this.eventHandlers) {
        handler(event);
      }
    });

    const port = await this.proxy.start();
    if (!this.unixSocketBridge) return;
    try {
      this.bridge = await startUnixSocketBridge(port);
    } catch (error) {
      await this.proxy.stop().catch(() => {});
      this.proxy = null;
      throw error;
    }
  }

  async stop(): Promise<void> {
    // Join any in-flight start() first: otherwise we could null `this.proxy` out
    // from under doStart()'s own `await this.proxy.start()` (throws), or orphan a
    // listener a concurrent start bound just after our check. A start's own failure
    // is irrelevant to a stop, so swallow it.
    if (this.startPromise) await this.startPromise.catch(() => {});
    if (this.bridge) {
      const bridge = this.bridge;
      this.bridge = null;
      await bridge.close();
    }
    if (!this.proxy) return;
    await this.proxy.stop();
    this.proxy = null;
  }

  /**
   * Get proxy env vars for injecting into sandboxed processes.
   * Returns both upper and lowercase variants for maximum compatibility.
   */
  getProxyEnv(): Record<string, string> {
    if (!this.proxy?.isRunning()) return {};

    const port = this.proxy.getPort();
    if (!port) return {};

    const proxyUrl = `http://127.0.0.1:${port}`;
    const noProxy = 'localhost,127.0.0.1,::1';

    return {
      HTTP_PROXY: proxyUrl,
      http_proxy: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      https_proxy: proxyUrl,
      NO_PROXY: noProxy,
      no_proxy: noProxy,
      // Node's fetch ignores the vars above unless opted in, and the sandbox blocks direct egress.
      NODE_USE_ENV_PROXY: '1',
    };
  }

  addAllowedDomain(domain: string): void {
    if (!this.networkConfig.allowedDomains.includes(domain)) {
      this.networkConfig.allowedDomains.push(domain);
      this.proxy?.updateAllowedDomains(this.networkConfig.allowedDomains);
    }
  }

  getAllowedDomains(): string[] {
    return [...this.networkConfig.allowedDomains];
  }

  isRunning(): boolean {
    return this.proxy?.isRunning() ?? false;
  }

  getPort(): number | null {
    return this.proxy?.getPort() ?? null;
  }

  /** Unix socket that forwards to the proxy; null unless the bridge was requested and is up. */
  getUnixSocketPath(): string | null {
    return this.isRunning() ? (this.bridge?.socketPath ?? null) : null;
  }

  /**
   * Subscribe to proxy events. Returns an unsubscribe function.
   */
  onEvent(handler: (event: ProxyEvent) => void): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }
}

interface UnixSocketBridge {
  socketPath: string;
  close(): Promise<void>;
}

async function startUnixSocketBridge(proxyPort: number): Promise<UnixSocketBridge> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'b4m-proxy-'));
  const socketPath = path.join(dir, 'proxy.sock');
  const removeDir = () => rmSync(dir, { recursive: true, force: true });
  const sockets = new Set<net.Socket>();
  const track = (socket: net.Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  };
  const server = net.createServer({ allowHalfOpen: true }, client => {
    const upstream = net.connect({ port: proxyPort, host: '127.0.0.1', allowHalfOpen: true });
    track(client);
    track(upstream);
    client.pipe(upstream).pipe(client);
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    removeDir();
    throw error;
  }
  // The CLI exits without stopping the proxy, so remove the socket dir on any normal exit.
  process.once('exit', removeDir);
  return {
    socketPath,
    async close() {
      process.off('exit', removeDir);
      // server.close() waits for open connections, so a held tunnel would keep egress up.
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      removeDir();
    },
  };
}
