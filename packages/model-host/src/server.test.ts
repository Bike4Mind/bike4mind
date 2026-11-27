import { stat } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { get, raw, tempDir } from './__test__/helpers';
import { HostServer, parsePreamble, sendJson, type RequestHandler, type ServerLimits } from './server';

const isRoot = process.getuid?.() === 0;

const echo: RequestHandler = ({ req, res, conn, body }) =>
  sendJson(res, 200, { role: conn.role, login: conn.login, url: req.url, bytes: body.length });

let cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
});

async function start(handler: RequestHandler = echo, limits: Partial<ServerLimits> = {}) {
  const { dir, cleanup } = await tempDir();
  const server = new HostServer(handler, limits);
  cleanups.push(cleanup, () => server.close());
  const manage = join(dir, 'manage.sock');
  const admin = join(dir, 'admin.sock');
  await server.listen({ role: 'manage', path: manage, mode: 0o660, gid: null });
  await server.listen({ role: 'admin', path: admin, mode: 0o600, gid: null });
  return { server, manage, admin, dir };
}

const body = (text: string) => JSON.parse(text.slice(text.indexOf('\r\n\r\n') + 4));

describe('HostServer', () => {
  it('gives each socket its mode and each connection the role of the socket it came in on', async () => {
    const { manage, admin } = await start();
    expect((await stat(manage)).mode & 0o777).toBe(0o660);
    expect((await stat(admin)).mode & 0o777).toBe(0o600);
    expect(JSON.parse((await get(manage, '/x')).body)).toMatchObject({ role: 'manage', login: null });
    expect(JSON.parse((await get(admin, '/x')).body)).toMatchObject({ role: 'admin', login: null });
  });

  it('reads a dial-stdio preamble as a label, even split across writes, and serves the request after it', async () => {
    const { manage } = await start();
    const reply = await raw(manage, 'B4M-DI', 'AL 1 user=alice uid=1000\nGET /a HTTP/1.0\r\n\r\n');
    expect(reply).toMatch(/^HTTP\/1\.1 200/);
    expect(body(reply)).toMatchObject({ role: 'manage', login: 'alice', url: '/a' });
  });

  it('answers a request whose client already half-closed', async () => {
    const { admin } = await start(async ctx => {
      await new Promise(resolve => setTimeout(resolve, 50));
      echo(ctx);
    });
    expect(body(await raw(admin, 'GET /late HTTP/1.1\r\nHost: x\r\n\r\n'))).toMatchObject({ url: '/late' });
  });

  it('closes a connection whose preamble runs past its limit or never ends', async () => {
    const { manage } = await start(echo, { preambleBytes: 32, firstByteTimeoutMs: 100 });
    expect(await raw(manage, `B4M-DIAL 1 user=${'a'.repeat(64)}\nGET / HTTP/1.0\r\n\r\n`)).toBe('');
    const silent = connect(manage);
    const closed = await new Promise<boolean>(resolve => {
      silent.on('close', () => resolve(true));
      silent.on('error', () => {});
      setTimeout(() => resolve(false), 2_000);
    });
    expect(closed).toBe(true);
  });

  it('refuses bodies over the limit, whether declared or streamed', async () => {
    const { manage } = await start(echo, { bodyBytes: 1024 });
    const declared = await raw(manage, 'POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 2048\r\n\r\n');
    expect(declared).toMatch(/^HTTP\/1\.1 413/);
    expect(body(declared)).toEqual({ code: 'body-too-large', message: expect.stringContaining('1024') });
    const chunk = 'x'.repeat(600);
    const streamed = await raw(
      manage,
      'POST / HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n',
      `258\r\n${chunk}\r\n`,
      `258\r\n${chunk}\r\n`,
      '0\r\n\r\n'
    );
    expect(streamed).toMatch(/^HTTP\/1\.1 413/);
    const fits = await raw(manage, `POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 600\r\n\r\n${chunk}`);
    expect(body(fits)).toMatchObject({ bytes: 600 });
  });

  it('refuses headers over the limit', async () => {
    const { manage } = await start(echo, { headerBytes: 1024 });
    expect(await raw(manage, `GET / HTTP/1.1\r\nHost: x\r\nX-Big: ${'a'.repeat(4096)}\r\n\r\n`)).toMatch(
      /^HTTP\/1\.1 431/
    );
  });

  it('rate limits each socket on its own and says when to retry', async () => {
    const { manage, admin } = await start(echo, { rateBurst: 2, ratePerSecond: 0.5 });
    expect((await get(manage, '/1')).status).toBe(200);
    expect((await get(manage, '/2')).status).toBe(200);
    const limited = await get(manage, '/3');
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBe('2');
    expect(JSON.parse(limited.body)).toMatchObject({ code: 'rate-limited' });
    expect((await get(admin, '/1')).status).toBe(200);
  });

  it('turns a handler failure into a 500 that does not repeat its message', async () => {
    const { manage } = await start(() => {
      throw new Error('secret detail');
    });
    const reply = await get(manage, '/');
    expect(reply.status).toBe(500);
    expect(reply.body).not.toContain('secret');
  });

  it('refuses a socket path longer than sun_path holds, and removes its sockets on close', async () => {
    const { server, manage, dir } = await start();
    await expect(
      server.listen({ role: 'admin', path: join(dir, 'x'.repeat(120)), mode: 0o600, gid: null })
    ).rejects.toThrow(/longer than 107 bytes/);
    await server.close();
    await expect(stat(manage)).rejects.toThrow(/ENOENT/);
  });

  it.skipIf(isRoot || process.getgroups?.().includes(0))(
    'closes and removes a socket whose group cannot be set',
    async () => {
      const { server, dir } = await start();
      const path = join(dir, 'extra.sock');
      await expect(server.listen({ role: 'chat', path, mode: 0o660, gid: 0 })).rejects.toThrow(/EPERM/);
      await expect(stat(path)).rejects.toThrow(/ENOENT/);
      await server.listen({ role: 'chat', path, mode: 0o600, gid: null });
      expect(server.listeners.map(listener => listener.path)).toContain(path);
    }
  );
});

describe('parsePreamble', () => {
  it('keeps a plain account name and nothing else', () => {
    expect(parsePreamble('B4M-DIAL 1 user=bob uid=1001')).toBe('bob');
    expect(parsePreamble('B4M-DIAL 1 uid=1001 user=svc.ci-2')).toBe('svc.ci-2');
    expect(parsePreamble('B4M-DIAL 1 user=bad$name uid=1')).toBeNull();
    expect(parsePreamble('B4M-DIAL 1')).toBeNull();
    expect(parsePreamble('B4M-DIAL 2 user=bob')).toBeNull();
    expect(parsePreamble('B4M-DIAL 1x user=bob')).toBeNull();
  });
});
