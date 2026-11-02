import { spawnSync } from 'node:child_process';
import { chmod } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from './__test__/helpers';
import { dialFirst, dialStdio, EXIT_NO_ACCESS, EXIT_NOT_RUNNING, exitCodeFor, login } from './dial';
import { HostServer, sendJson } from './server';

const isRoot = process.getuid?.() === 0;

let cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
});

async function setup() {
  const { dir, cleanup } = await tempDir();
  cleanups.push(cleanup);
  const server = new HostServer(({ res, conn }) => sendJson(res, 200, conn));
  cleanups.push(() => server.close());
  const admin = join(dir, 'admin.sock');
  const manage = join(dir, 'manage.sock');
  return { dir, server, admin, manage };
}

/** A socket file that nothing listens on, as a killed host leaves behind. */
function staleSocket(path: string): void {
  const script = `require('net').createServer().listen(${JSON.stringify(path)}, () => process.kill(process.pid, 'SIGKILL'))`;
  spawnSync(process.execPath, ['-e', script]);
}

async function bridge(candidates: string[], request: string) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', chunk => (out += chunk));
  stderr.on('data', chunk => (err += chunk));
  const done = dialStdio({ candidates, stdin, stdout, stderr });
  stdin.end(request);
  return { code: await done, out, err };
}

describe('dialFirst', () => {
  it('reports a host that is not running when no socket exists or none answers', async () => {
    const { admin, manage } = await setup();
    const missing = await dialFirst([admin, manage]);
    expect(missing).toMatchObject({ ok: false, failure: 'not-running', path: null });
    staleSocket(manage);
    expect(await dialFirst([admin, manage])).toMatchObject({ ok: false, failure: 'not-running', path: manage });
    expect(exitCodeFor('not-running')).toBe(EXIT_NOT_RUNNING);
  });

  it.skipIf(isRoot)('reports no access when the only live socket cannot be opened', async () => {
    const { server, admin, manage } = await setup();
    await server.listen({ role: 'manage', path: manage, mode: 0o600, gid: null });
    await chmod(manage, 0o000);
    const result = await dialFirst([admin, manage]);
    expect(result).toMatchObject({ ok: false, failure: 'no-access', path: manage });
    expect(!result.ok && result.message).toContain(`usermod -aG b4m-host ${login()}`);
    expect(exitCodeFor('no-access')).toBe(EXIT_NO_ACCESS);
    staleSocket(admin);
    expect(await dialFirst([admin, manage])).toMatchObject({ failure: 'not-running', path: admin });
  });
});

describe('dialStdio', () => {
  it('sends the preamble and bridges a request and its reply', async () => {
    const { server, admin, manage } = await setup();
    await server.listen({ role: 'admin', path: admin, mode: 0o600, gid: null });
    const { code, out } = await bridge([admin, manage], 'GET /v1/x HTTP/1.0\r\n\r\n');
    expect(code).toBe(0);
    expect(out).toMatch(/^HTTP\/1\.1 200 OK/);
    expect(JSON.parse(out.slice(out.indexOf('\r\n\r\n') + 4))).toEqual({
      role: 'admin',
      login: login()
        .replace(/[^A-Za-z0-9._-]/g, '_')
        .slice(0, 64),
    });
  });

  it.skipIf(isRoot)('falls back to the manage socket when the admin one is out of reach', async () => {
    const { server, admin, manage } = await setup();
    await server.listen({ role: 'admin', path: admin, mode: 0o600, gid: null });
    await server.listen({ role: 'manage', path: manage, mode: 0o600, gid: null });
    await chmod(admin, 0o000);
    const { out } = await bridge([admin, manage], 'GET / HTTP/1.0\r\n\r\n');
    expect(JSON.parse(out.slice(out.indexOf('\r\n\r\n') + 4)).role).toBe('manage');
  });

  it('exits 0 once the host closes a kept-alive connection, while stdin is still open', async () => {
    const { dir, cleanup } = await tempDir();
    cleanups.push(cleanup);
    const server = new HostServer(({ res, conn }) => sendJson(res, 200, conn), { keepAliveTimeoutMs: 100 });
    cleanups.push(() => server.close());
    const admin = join(dir, 'admin.sock');
    await server.listen({ role: 'admin', path: admin, mode: 0o600, gid: null });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let out = '';
    let err = '';
    stdout.on('data', chunk => (out += chunk));
    stderr.on('data', chunk => (err += chunk));
    const done = dialStdio({ candidates: [admin], stdin, stdout, stderr });
    stdin.write('GET /v1/x HTTP/1.1\r\nHost: h\r\n\r\n');
    const code = await Promise.race([done, new Promise(resolve => setTimeout(() => resolve('timed out'), 3_000))]);
    expect(code).toBe(0);
    expect(out).toMatch(/^HTTP\/1\.1 200 OK/);
    // A request written after the host left goes nowhere: no EPIPE, nothing on stderr.
    stdin.write('GET /v1/y HTTP/1.1\r\nHost: h\r\n\r\n');
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(err).toBe('');
    expect(out.match(/HTTP\/1\.1 /g)).toHaveLength(1);
    expect(stdin.writableEnded).toBe(false);
  });

  it('exits 1 when the host closes without answering', async () => {
    const { dir, cleanup } = await tempDir();
    cleanups.push(cleanup);
    const path = join(dir, 'admin.sock');
    const silent = createServer(socket => socket.resume().end());
    await new Promise<void>(resolve => silent.listen(path, resolve));
    cleanups.push(() => new Promise<void>(resolve => silent.close(() => resolve())));
    const { code, out, err } = await bridge([path], 'GET / HTTP/1.0\r\n\r\n');
    expect(code).toBe(1);
    expect(out).toBe('');
    expect(err).toBe('b4m-host: the host closed the connection\n');
  });

  it('exits 3 with how to start the service when nothing listens', async () => {
    const { admin, manage } = await setup();
    const { code, out, err } = await bridge([admin, manage], 'GET / HTTP/1.0\r\n\r\n');
    expect(code).toBe(EXIT_NOT_RUNNING);
    expect(out).toBe('');
    expect(err).toContain('sudo systemctl start b4m-host');
  });
});
