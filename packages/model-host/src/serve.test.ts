import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { ModelHostHelloSchema } from '@bike4mind/common/modelHub';
import { afterEach, describe, expect, it } from 'vitest';
import { get, probe, tempDir } from './__test__/helpers';
import { checkOllamaUrl, machineIdentity, readServerId, serve, type ServeOptions } from './serve';
import type { ListenerSpec } from './server';

const NO_OLLAMA = 'http://127.0.0.1:9';
const isRoot = process.getuid?.() === 0;

/** A socket file that nothing listens on, as a killed host leaves behind. */
function staleSocket(path: string): void {
  spawnSync(process.execPath, [
    '-e',
    `require('net').createServer().listen(${JSON.stringify(path)}, () => process.kill(process.pid, 'SIGKILL'))`,
  ]);
}

let cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
});

/** Starts `serve` and resolves once it listens, with a stop function that waits for it to finish. */
async function start(options: Partial<ServeOptions> & Pick<ServeOptions, 'socketDir' | 'stateDir'>) {
  const controller = new AbortController();
  const logs: string[] = [];
  let listening!: (listeners: ListenerSpec[]) => void;
  const ready = new Promise<ListenerSpec[]>(resolve => (listening = resolve));
  const running = serve({
    mode: 'user',
    ollamaUrl: NO_OLLAMA,
    signal: controller.signal,
    log: line => logs.push(line),
    onListening: listening,
    probe,
    ...options,
  });
  const listeners = await Promise.race([ready, running.then(() => [] as ListenerSpec[])]);
  const stop = async () => {
    controller.abort();
    await running.catch(() => undefined);
  };
  cleanups.push(stop);
  return { listeners, logs, stop, running };
}

async function dirs() {
  const { dir, cleanup } = await tempDir();
  cleanups.push(cleanup);
  return { socketDir: join(dir, 'run'), stateDir: join(dir, 'state'), dir };
}

describe('serve', () => {
  it('runs a user host on one owner-only admin socket with a lasting server id, and cleans up on stop', async () => {
    const { socketDir, stateDir } = await dirs();
    const { listeners, stop } = await start({ socketDir, stateDir });
    const admin = join(socketDir, 'admin.sock');
    expect(listeners).toEqual([{ role: 'admin', path: admin, mode: 0o600, gid: null }]);
    expect((await stat(admin)).mode & 0o777).toBe(0o600);
    expect((await stat(socketDir)).mode & 0o777).toBe(0o700);
    const hello = ModelHostHelloSchema.parse(JSON.parse((await get(admin, '/v1/hello')).body));
    expect(hello).toMatchObject({ mode: 'user', role: 'admin', ollama: { url: NO_OLLAMA, reachable: false } });
    expect(hello.serverId).toBe(JSON.parse(await readFile(join(stateDir, 'server-id'), 'utf8')).id);
    await stop();
    await expect(stat(admin)).rejects.toThrow(/ENOENT/);
    await expect(stat(join(stateDir, 'serve.lock'))).rejects.toThrow(/ENOENT/);
  });

  it('gives each system socket its group when the group exists, and only the owner otherwise', async () => {
    const { socketDir, stateDir, dir } = await dirs();
    const gid = process.getgid?.() ?? 0;
    const groupFile = join(dir, 'group');
    await writeFile(groupFile, `b4m-host:x:${gid}:\n`);
    const { listeners, logs } = await start({ mode: 'system', socketDir, stateDir, groupFile });
    expect(listeners).toEqual([
      { role: 'manage', path: join(socketDir, 'manage.sock'), mode: 0o660, gid },
      { role: 'admin', path: join(socketDir, 'admin.sock'), mode: 0o600, gid: null },
    ]);
    const manage = await stat(join(socketDir, 'manage.sock'));
    expect([manage.mode & 0o777, manage.gid]).toEqual([0o660, gid]);
    // Group members must reach manage.sock; the state dir stays closed to others.
    expect((await stat(socketDir)).mode & 0o777).toBe(0o755);
    expect((await stat(stateDir)).mode & 0o777).toBe(0o750);
    expect(logs).toContain(
      `group b4m-host-admin does not exist; ${join(socketDir, 'admin.sock')} is limited to this user`
    );
    const roles = await Promise.all(
      listeners.map(
        async ({ path }) => ModelHostHelloSchema.parse(JSON.parse((await get(path, '/v1/hello')).body)).role
      )
    );
    expect(roles).toEqual(['manage', 'admin']);
  });

  it('refuses a second host on the same state or a live socket, and replaces a stale socket', async () => {
    const { socketDir, stateDir, dir } = await dirs();
    await start({ socketDir, stateDir });
    await expect(serve({ ...base(), socketDir: join(dir, 'other'), stateDir })).rejects.toThrow(
      /Another b4m-host is running/
    );
    await expect(serve({ ...base(), socketDir, stateDir: join(dir, 'state2') })).rejects.toThrow(
      `Another b4m-host is running with sockets in ${socketDir}`
    );

    const fresh = await dirs();
    const stale = join(fresh.socketDir, 'admin.sock');
    await mkdir(fresh.socketDir, { recursive: true, mode: 0o700 });
    staleSocket(stale);
    expect((await stat(stale)).isSocket()).toBe(true);
    await start(fresh);
    expect((await get(stale, '/v1/hello')).status).toBe(200);
  });

  it.skipIf(isRoot)('refuses a socket it cannot probe instead of removing it', async () => {
    const { socketDir, stateDir } = await dirs();
    const sock = join(socketDir, 'admin.sock');
    await mkdir(socketDir, { recursive: true, mode: 0o700 });
    staleSocket(sock);
    await chmod(sock, 0o000);
    await expect(serve({ ...base(), socketDir, stateDir })).rejects.toThrow(
      /Cannot tell whether .* is in use \(EACCES\)/
    );
    expect((await lstat(sock)).isSocket()).toBe(true);
  });

  it('takes over the lock of a host on this machine that crashed, without waiting for it to go stale', async () => {
    const { socketDir, stateDir } = await dirs();
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const dead = spawnSync(process.execPath, ['-e', '0']).pid;
    const lock = { pid: dead, host: hostname(), machine: await machineIdentity(), nonce: 'x' };
    await writeFile(join(stateDir, 'serve.lock'), JSON.stringify(lock));
    const { listeners } = await start({ socketDir, stateDir });
    expect(listeners).toHaveLength(1);
  });

  it('leaves a lock from another machine with the same hostname alone, even a stale one', async () => {
    const { socketDir, stateDir } = await dirs();
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const dead = spawnSync(process.execPath, ['-e', '0']).pid;
    const lockPath = join(stateDir, 'serve.lock');
    await writeFile(lockPath, JSON.stringify({ pid: dead, host: hostname(), machine: 'another-machine', nonce: 'x' }));
    await utimes(lockPath, new Date(0), new Date(0));
    await expect(serve({ ...base(), socketDir, stateDir })).rejects.toThrow(
      `Another b4m-host is running with state in ${stateDir} (pid ${dead} on ${hostname()}); if that machine no longer runs it, remove ${lockPath}`
    );
    expect(JSON.parse(await readFile(lockPath, 'utf8')).nonce).toBe('x');
  });

  it('leaves a fresh lock held from another machine alone, whatever its pid', async () => {
    const { socketDir, stateDir } = await dirs();
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const dead = spawnSync(process.execPath, ['-e', '0']).pid;
    await writeFile(join(stateDir, 'serve.lock'), JSON.stringify({ pid: dead, host: 'other-box', nonce: 'x' }));
    await expect(serve({ ...base(), socketDir, stateDir })).rejects.toThrow(
      `Another b4m-host is running with state in ${stateDir} (pid ${dead} on other-box); if that machine no longer runs it, remove ${join(stateDir, 'serve.lock')}`
    );
  });

  it('stops with an error once another host has taken its lock over', async () => {
    const { socketDir, stateDir } = await dirs();
    const { running } = await start({ socketDir, stateDir, lockCheckMs: 20 });
    await writeFile(join(stateDir, 'serve.lock'), JSON.stringify({ pid: 1, host: 'other-box', nonce: 'theirs' }));
    await expect(running).rejects.toThrow(/Lost the lock on .*another b4m-host took it over/);
    await expect(stat(join(socketDir, 'admin.sock'))).rejects.toThrow(/ENOENT/);
    expect(JSON.parse(await readFile(join(stateDir, 'serve.lock'), 'utf8')).nonce).toBe('theirs');
  });

  it('refuses a socket or state directory that others can write or that is a symlink', async () => {
    const { socketDir, stateDir, dir } = await dirs();
    await mkdir(socketDir, { mode: 0o700 });
    await chmod(socketDir, 0o770);
    await expect(serve({ ...base(), socketDir, stateDir })).rejects.toThrow(/writable by group or others \(mode 770\)/);
    const real = join(dir, 'real');
    await mkdir(real, { mode: 0o700 });
    const linked = join(dir, 'linked');
    await symlink(real, linked);
    await expect(serve({ ...base(), socketDir: join(dir, 'run2'), stateDir: linked })).rejects.toThrow(
      /is not a directory/
    );
  });

  it('refuses an Ollama that is not on loopback before touching anything', async () => {
    const { socketDir, stateDir } = await dirs();
    await expect(serve({ ...base(), socketDir, stateDir, ollamaUrl: 'http://192.168.1.5:11434' })).rejects.toThrow(
      /loopback/
    );
    await expect(stat(stateDir)).rejects.toThrow(/ENOENT/);
  });
});

function base(): ServeOptions {
  return { mode: 'user', ollamaUrl: NO_OLLAMA, signal: AbortSignal.abort(), log: () => {}, probe };
}

describe('checkOllamaUrl', () => {
  it('accepts http on loopback only', () => {
    expect(checkOllamaUrl('http://127.0.0.1:11434/')).toBe('http://127.0.0.1:11434');
    expect(checkOllamaUrl('http://localhost:11434')).toBe('http://localhost:11434');
    expect(checkOllamaUrl('http://[::1]:11434')).toBe('http://[::1]:11434');
    for (const url of ['https://127.0.0.1:11434', 'http://10.0.0.2:11434', 'http://u:p@127.0.0.1:11434', 'nope']) {
      expect(() => checkOllamaUrl(url)).toThrow();
    }
  });
});

describe('readServerId', () => {
  it('creates an id once and keeps it on the same machine', async () => {
    const { dir, cleanup } = await tempDir();
    cleanups.push(cleanup);
    const id = await readServerId(dir);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await readServerId(dir)).toBe(id);
    expect(JSON.parse(await readFile(join(dir, 'server-id'), 'utf8'))).toEqual({
      id,
      machine: await machineIdentity(),
    });
  });

  it('makes a new id when the state directory came from another machine', async () => {
    const { dir, cleanup } = await tempDir();
    cleanups.push(cleanup);
    const first = await readServerId(dir, 'machine-a');
    const second = await readServerId(dir, 'machine-b');
    expect(second).not.toBe(first);
    expect(await readServerId(dir, 'machine-b')).toBe(second);
  });

  it('replaces a planted symlink instead of reading or writing through it', async () => {
    const { dir, cleanup } = await tempDir();
    cleanups.push(cleanup);
    const target = join(dir, 'elsewhere');
    await writeFile(target, JSON.stringify({ id: 'planted-id-0000', machine: 'm' }));
    await symlink(target, join(dir, 'server-id'));
    const id = await readServerId(dir, 'm');
    expect(id).not.toBe('planted-id-0000');
    expect((await lstat(join(dir, 'server-id'))).isFile()).toBe(true);
    expect(JSON.parse(await readFile(target, 'utf8')).id).toBe('planted-id-0000');
  });
});
