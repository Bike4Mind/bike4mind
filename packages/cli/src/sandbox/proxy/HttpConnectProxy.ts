/**
 * HTTP CONNECT proxy for network domain filtering.
 *
 * Intercepts outbound HTTP/HTTPS connections from sandboxed commands
 * and filters by domain allowlist. Uses only Node.js built-ins.
 *
 * - CONNECT handler (HTTPS): Parse domain -> check allowlist -> tunnel or 403
 * - HTTP handler (forward proxy): Parse host -> check allowlist -> forward or 403
 */
import http from 'http';
import net from 'net';
import type { Duplex } from 'stream';
import { EventEmitter } from 'events';
import { isDomainAllowed } from './domainMatcher.js';

export interface ProxyEvent {
  type: 'allowed' | 'blocked';
  domain: string;
  method: string;
  timestamp: Date;
}

export interface HttpConnectProxyOptions {
  allowedDomains: string[];
  port?: number;
}

export class HttpConnectProxy extends EventEmitter {
  private server: http.Server | null = null;
  private allowedDomains: string[];
  private requestedPort: number;
  private activeSockets = new Set<net.Socket>();

  constructor(options: HttpConnectProxyOptions) {
    super();
    this.allowedDomains = [...options.allowedDomains];
    this.requestedPort = options.port ?? 0;
  }

  async start(): Promise<number> {
    if (this.server) {
      throw new Error('Proxy is already running');
    }

    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handleHttpRequest(req, res);
      });

      server.on('connect', (req: http.IncomingMessage, clientSocket: Duplex, head: Buffer) => {
        this.handleConnect(req, clientSocket as net.Socket, head);
      });

      server.on('connection', socket => {
        this.activeSockets.add(socket);
        socket.on('close', () => this.activeSockets.delete(socket));
      });

      server.on('error', reject);

      server.listen(this.requestedPort, '127.0.0.1', () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') {
          reject(new Error('Failed to get server address'));
          return;
        }
        this.server = server;
        resolve(addr.port);
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;

    // Destroy all active sockets
    for (const socket of this.activeSockets) {
      socket.destroy();
    }
    this.activeSockets.clear();

    return new Promise((resolve, reject) => {
      this.server!.close(err => {
        this.server = null;
        if (err) reject(err);
        else resolve();
      });
    });
  }

  updateAllowedDomains(domains: string[]): void {
    this.allowedDomains = [...domains];
  }

  getPort(): number | null {
    if (!this.server) return null;
    const addr = this.server.address();
    if (!addr || typeof addr === 'string') return null;
    return addr.port;
  }

  isRunning(): boolean {
    return this.server !== null;
  }

  private emitEvent(type: 'allowed' | 'blocked', domain: string, method: string): void {
    const event: ProxyEvent = { type, domain, method, timestamp: new Date() };
    this.emit('proxy-event', event);
  }

  /**
   * Handle CONNECT requests (HTTPS tunneling).
   */
  private handleConnect(req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer): void {
    const target = req.url || '';
    const [host] = target.split(':');
    const port = parseInt(target.split(':')[1] || '443', 10);

    if (!isDomainAllowed(host, this.allowedDomains)) {
      this.emitEvent('blocked', host, 'CONNECT');
      clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      clientSocket.end();
      return;
    }

    this.emitEvent('allowed', host, 'CONNECT');

    const serverSocket = net.connect(port, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) {
        serverSocket.write(head);
      }
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    });

    serverSocket.setTimeout(5000, () => {
      serverSocket.destroy();
      clientSocket.write('HTTP/1.1 504 Gateway Timeout\r\n\r\n');
      clientSocket.end();
    });

    serverSocket.on('error', () => {
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      clientSocket.end();
    });

    clientSocket.on('error', () => {
      serverSocket.destroy();
    });
  }

  /**
   * Handle plain HTTP forward proxy requests.
   */
  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url || '';
    let host: string;

    try {
      const parsed = new URL(url);
      host = parsed.hostname;
    } catch {
      // Fallback to Host header
      host = (req.headers.host || '').split(':')[0];
    }

    if (!host || !isDomainAllowed(host, this.allowedDomains)) {
      this.emitEvent('blocked', host || 'unknown', req.method || 'GET');
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Blocked by sandbox network proxy');
      return;
    }

    this.emitEvent('allowed', host, req.method || 'GET');

    const parsed = new URL(url);
    const proxyReq = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 80,
        path: parsed.pathname + parsed.search,
        method: req.method,
        headers: req.headers,
      },
      proxyRes => {
        res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
        proxyRes.pipe(res);
      }
    );

    proxyReq.on('error', () => {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Bad Gateway');
    });

    req.pipe(proxyReq);
  }
}
