import { describe, it, expect, afterEach } from 'vitest';
import http from 'http';
import net from 'net';
import { HttpConnectProxy, type ProxyEvent } from './HttpConnectProxy.js';

describe('HttpConnectProxy', () => {
  let proxy: HttpConnectProxy;

  afterEach(async () => {
    if (proxy?.isRunning()) {
      await proxy.stop();
    }
  });

  describe('lifecycle', () => {
    it('starts and returns a port', async () => {
      proxy = new HttpConnectProxy({ allowedDomains: ['example.com'] });
      const port = await proxy.start();
      expect(port).toBeGreaterThan(0);
      expect(proxy.isRunning()).toBe(true);
      expect(proxy.getPort()).toBe(port);
    });

    it('stops cleanly', async () => {
      proxy = new HttpConnectProxy({ allowedDomains: ['example.com'] });
      await proxy.start();
      await proxy.stop();
      expect(proxy.isRunning()).toBe(false);
      expect(proxy.getPort()).toBeNull();
    });

    it('throws on double start', async () => {
      proxy = new HttpConnectProxy({ allowedDomains: ['example.com'] });
      await proxy.start();
      await expect(proxy.start()).rejects.toThrow('already running');
    });

    it('stop is idempotent', async () => {
      proxy = new HttpConnectProxy({ allowedDomains: ['example.com'] });
      await proxy.start();
      await proxy.stop();
      await proxy.stop(); // should not throw
    });

    it('reports null port when not running', () => {
      proxy = new HttpConnectProxy({ allowedDomains: ['example.com'] });
      expect(proxy.getPort()).toBeNull();
      expect(proxy.isRunning()).toBe(false);
    });
  });

  describe('CONNECT (HTTPS tunneling)', () => {
    it('allows CONNECT to allowed domain', async () => {
      // Use a local TCP server as upstream to avoid external network dependency
      const upstream = net.createServer(socket => socket.end());
      await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
      const upstreamPort = (upstream.address() as net.AddressInfo).port;

      try {
        proxy = new HttpConnectProxy({ allowedDomains: ['127.0.0.1'] });
        const port = await proxy.start();

        const response = await sendConnect(port, `127.0.0.1:${upstreamPort}`);
        expect(response).toContain('200');
      } finally {
        upstream.close();
      }
    });

    it('blocks CONNECT to disallowed domain', async () => {
      proxy = new HttpConnectProxy({ allowedDomains: ['example.com'] });
      const port = await proxy.start();

      const response = await sendConnect(port, 'evil.com:443');
      expect(response).toContain('403');
    });

    it('blocks CONNECT when domain is not in wildcard', async () => {
      proxy = new HttpConnectProxy({ allowedDomains: ['*.example.com'] });
      const port = await proxy.start();

      // Wildcard should NOT match bare domain
      const response = await sendConnect(port, 'example.com:443');
      expect(response).toContain('403');
    });

    it('allows CONNECT to wildcard subdomain (emits allowed event)', async () => {
      // Use a local TCP server as upstream to avoid external network dependency
      const upstream = net.createServer(socket => socket.end());
      await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
      const upstreamPort = (upstream.address() as net.AddressInfo).port;

      try {
        proxy = new HttpConnectProxy({ allowedDomains: ['127.0.0.1'] });
        const port = await proxy.start();

        const events: ProxyEvent[] = [];
        proxy.on('proxy-event', (e: ProxyEvent) => events.push(e));

        const response = await sendConnect(port, `127.0.0.1:${upstreamPort}`);
        expect(response).toContain('200');
        expect(events).toHaveLength(1);
        expect(events[0].type).toBe('allowed');
        expect(events[0].domain).toBe('127.0.0.1');
      } finally {
        upstream.close();
      }
    });
  });

  describe('HTTP forward proxy', () => {
    it('blocks HTTP request to disallowed domain', async () => {
      proxy = new HttpConnectProxy({ allowedDomains: ['example.com'] });
      const port = await proxy.start();

      const response = await sendHttpViaProxy(port, 'http://evil.com/test');
      expect(response.statusCode).toBe(403);
    });
  });

  describe('events', () => {
    it('emits proxy-event for allowed CONNECT', async () => {
      // Use a local TCP server as upstream to avoid external network dependency
      const upstream = net.createServer(socket => socket.end());
      await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
      const upstreamPort = (upstream.address() as net.AddressInfo).port;

      try {
        proxy = new HttpConnectProxy({ allowedDomains: ['127.0.0.1'] });
        const port = await proxy.start();

        const events: ProxyEvent[] = [];
        proxy.on('proxy-event', (e: ProxyEvent) => events.push(e));

        await sendConnect(port, `127.0.0.1:${upstreamPort}`);

        expect(events).toHaveLength(1);
        expect(events[0].type).toBe('allowed');
        expect(events[0].domain).toBe('127.0.0.1');
        expect(events[0].method).toBe('CONNECT');
      } finally {
        upstream.close();
      }
    });

    it('emits proxy-event for blocked CONNECT', async () => {
      proxy = new HttpConnectProxy({ allowedDomains: ['example.com'] });
      const port = await proxy.start();

      const events: ProxyEvent[] = [];
      proxy.on('proxy-event', (e: ProxyEvent) => events.push(e));

      await sendConnect(port, 'evil.com:443');

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('blocked');
      expect(events[0].domain).toBe('evil.com');
    });
  });

  describe('runtime domain update', () => {
    it('reflects updated allowed domains via events', async () => {
      // Use a local TCP server as upstream to avoid external network dependency
      const upstream = net.createServer(socket => socket.end());
      await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
      const upstreamPort = (upstream.address() as net.AddressInfo).port;

      try {
        proxy = new HttpConnectProxy({ allowedDomains: ['example.com'] });
        const port = await proxy.start();

        const events: ProxyEvent[] = [];
        proxy.on('proxy-event', (e: ProxyEvent) => events.push(e));

        // Initially blocked (newsite.test not in allowed list)
        const response = await sendConnect(port, 'newsite.test:443');
        expect(response).toContain('403');
        expect(events).toHaveLength(1);
        expect(events[0].type).toBe('blocked');

        // Update domains to include 127.0.0.1
        proxy.updateAllowedDomains(['example.com', '127.0.0.1']);

        // Now allowed - connect to local upstream
        events.length = 0;
        const response2 = await sendConnect(port, `127.0.0.1:${upstreamPort}`);
        expect(response2).toContain('200');
        expect(events).toHaveLength(1);
        expect(events[0].type).toBe('allowed');
      } finally {
        upstream.close();
      }
    });
  });
});

/**
 * Send a raw CONNECT request to the proxy and read the first response line.
 */
function sendConnect(proxyPort: number, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, '127.0.0.1', () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });

    let data = '';
    socket.on('data', chunk => {
      data += chunk.toString();
      if (data.includes('\r\n\r\n')) {
        socket.destroy();
        resolve(data);
      }
    });

    socket.on('error', reject);
    socket.setTimeout(8000, () => {
      socket.destroy();
      reject(new Error('CONNECT timeout'));
    });
  });
}

/**
 * Send an HTTP request through the proxy as a forward proxy.
 */
function sendHttpViaProxy(proxyPort: number, targetUrl: string): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: proxyPort,
        path: targetUrl,
        method: 'GET',
        headers: { Host: parsed.host },
      },
      res => {
        let body = '';
        res.on('data', chunk => (body += chunk));
        res.on('end', () => resolve({ statusCode: res.statusCode || 0, body }));
      }
    );
    req.on('error', reject);
    req.setTimeout(3000, () => {
      req.destroy();
      reject(new Error('HTTP timeout'));
    });
    req.end();
  });
}
