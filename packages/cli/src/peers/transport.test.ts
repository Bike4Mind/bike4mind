import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PeerIdentity, PeerRequest } from './protocol.js';
import { callPeer, discoverPeers, ensurePeerRoot, startPeerTransport } from './transport.js';

const network = vi.hoisted(() => ({ endpoints: new Map<string, unknown>() }));

vi.mock('node:net', async () => {
  const { EventEmitter } = await import('node:events');
  class FakeSocket extends EventEmitter {
    peer?: FakeSocket;
    destroyed = false;
    writable = true;
    flowing = false;
    queued: Buffer[] = [];
    pause() {
      this.flowing = false;
      return this;
    }
    resume() {
      this.flowing = true;
      queueMicrotask(() => this.flush());
      return this;
    }
    flush() {
      while (this.flowing && !this.destroyed && this.queued.length) this.emit('data', this.queued.shift()!);
    }
    write(value: string) {
      if (this.destroyed) throw new Error('closed');
      this.peer!.queued.push(Buffer.from(value));
      queueMicrotask(() => this.peer!.flush());
      return true;
    }
    end() {
      queueMicrotask(() => {
        this.peer?.flush();
        this.peer?.emit('end');
        this.destroy();
      });
      return this;
    }
    destroy(error?: Error) {
      if (this.destroyed) return this;
      this.destroyed = true;
      this.writable = false;
      if (error) this.emit('error', error);
      this.emit('close');
      this.peer?.destroy();
      return this;
    }
  }
  class FakeServer extends EventEmitter {
    listening = false;
    endpoint = '';
    maxConnections = 0;
    constructor(readonly accept: (socket: FakeSocket) => void) {
      super();
    }
    listen(endpoint: string, done: () => void) {
      queueMicrotask(() => {
        if (network.endpoints.has(endpoint)) {
          this.emit('error', new Error('address in use'));
          return;
        }
        this.endpoint = endpoint;
        this.listening = true;
        network.endpoints.set(endpoint, this);
        done();
      });
      return this;
    }
    close(done: () => void) {
      network.endpoints.delete(this.endpoint);
      this.listening = false;
      queueMicrotask(done);
      return this;
    }
  }
  return {
    createServer: (accept: (socket: FakeSocket) => void) => new FakeServer(accept),
    createConnection: ({ path }: { path: string }) => {
      const socket = new FakeSocket();
      const receiver = new FakeSocket();
      socket.peer = receiver;
      receiver.peer = socket;
      queueMicrotask(() => {
        const server = network.endpoints.get(path) as FakeServer | undefined;
        if (!server) {
          socket.destroy(new Error('unavailable'));
          return;
        }
        server.accept(receiver);
        socket.emit('connect');
      });
      return socket;
    },
  };
});

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    lstat: async (path: string, ...args: []) =>
      network.endpoints.has(String(path))
        ? { uid: process.getuid!(), mode: 0o600, isSocket: () => true }
        : actual.lstat(path, ...args),
    chmod: async (path: string, mode: number) => {
      if (!network.endpoints.has(String(path))) await actual.chmod(path, mode);
    },
  };
});

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
  network.endpoints.clear();
  vi.restoreAllMocks();
});

async function fixture() {
  const directory = await mkdtemp(join(await realpath('/tmp'), 'b4m-peer-test-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function identity(overrides: Partial<PeerIdentity> = {}): PeerIdentity {
  return {
    id: randomUUID(),
    generation: randomUUID(),
    threadId: randomUUID(),
    name: 'Test peer',
    projectId: 'project',
    accountId: 'account',
    ...overrides,
  };
}

const request: PeerRequest = { type: 'status', messageId: 'message' };

async function peer(root: string, value = identity(), handle = vi.fn(async () => ({ ok: true as const }))) {
  const transport = await startPeerTransport({ root, identity: value, handle });
  cleanup.push(transport.close);
  return { ...transport, identity: value, handle };
}

describe('peer transport', () => {
  it('discovers scoped identities without publishing capability secrets', async () => {
    const root = await fixture();
    const source = await peer(root);
    await peer(root, identity({ accountId: 'other' }));
    expect(await discoverPeers(root, source.identity)).toEqual([source.identity]);
    expect((await lstat(root)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(root, `${source.identity.id}.json`))).mode & 0o777).toBe(0o600);
    expect(await discoverPeers(root)).toHaveLength(2);
    await source.close();
    expect(await discoverPeers(root)).toHaveLength(1);
  });

  it('binds the sender to its live registered identity and negotiates an authenticated exchange', async () => {
    const root = await fixture();
    const source = await peer(root);
    const target = await peer(root);
    expect(await callPeer(root, source.identity, target.identity.id, request)).toEqual({ ok: true });
    expect(target.handle).toHaveBeenCalledWith(source.identity, request);
    expect(await callPeer(root, { ...source.identity, name: 'Forged' }, target.identity.id, request)).toMatchObject({
      ok: false,
    });
    expect(target.handle).toHaveBeenCalledTimes(1);
  });

  it('refuses cross-account, cross-project and stale sender generations before dispatch', async () => {
    const root = await fixture();
    const source = await peer(root);
    const otherAccount = await peer(root, identity({ accountId: 'other' }));
    const otherProject = await peer(root, identity({ projectId: 'other' }));
    expect(await callPeer(root, source.identity, otherAccount.identity.id, request)).toMatchObject({ ok: false });
    expect(await callPeer(root, source.identity, otherProject.identity.id, request)).toMatchObject({ ok: false });
    expect(
      await callPeer(root, { ...source.identity, generation: randomUUID() }, otherProject.identity.id, request)
    ).toMatchObject({ ok: false });
    expect(otherAccount.handle).not.toHaveBeenCalled();
    expect(otherProject.handle).not.toHaveBeenCalled();
  });

  it('queries readiness separately and exposes no RPC for answering permissions', async () => {
    const root = await fixture();
    const source = await peer(root);
    const handle = vi.fn(async () => ({ ok: true as const, presence: { policy: 'hold' as const, ready: false } }));
    const target = await startPeerTransport({ root, identity: identity(), handle });
    cleanup.push(target.close);
    expect(await callPeer(root, source.identity, target.manifest.id, { type: 'presence' })).toEqual({
      ok: true,
      presence: { policy: 'hold', ready: false },
    });
    expect(
      await callPeer(root, source.identity, target.manifest.id, { type: 'approve' } as unknown as PeerRequest)
    ).toMatchObject({ ok: false });
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it('does not return another sender receipt or treat an uncertain dispatch as a retryable refusal', async () => {
    const root = await fixture();
    const source = await peer(root);
    const handle = vi.fn(async () => ({
      ok: true as const,
      receipt: {
        id: 'message',
        senderId: 'another',
        recipientId: 'wrong',
        status: 'completed' as const,
        createdAt: 1,
        expiresAt: 2,
        hops: 0,
        result: 'private',
      },
    }));
    const target = await startPeerTransport({ root, identity: identity(), handle });
    cleanup.push(target.close);
    const response = await callPeer(root, source.identity, target.manifest.id, request);
    expect(response).toEqual({
      ok: false,
      error: 'Delivery could not be confirmed. Do not automatically retry.',
      unknown: true,
    });
    expect(handle).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(response)).not.toContain('private');
  });

  it('excludes expired manifests and refuses world-readable registry files and symlink parents', async () => {
    const root = await fixture();
    const source = await peer(root);
    const path = join(root, `${source.identity.id}.json`);
    const manifest = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    await writeFile(path, JSON.stringify({ ...manifest, updatedAt: Date.now() - 46_000 }));
    expect(await discoverPeers(root)).toEqual([]);
    await writeFile(path, JSON.stringify(manifest));
    await chmod(path, 0o644);
    expect(await discoverPeers(root)).toEqual([]);
    const link = join(root, 'link');
    await symlink(root, link);
    await expect(ensurePeerRoot(join(link, 'child'))).rejects.toThrow(/symbolic links/);
    await chmod(root, 0o755);
    await expect(ensurePeerRoot(root)).rejects.toThrow(/private/);
    await chmod(root, 0o700);
  });

  it('prunes only abandoned private manifests and does not count stale files against enrollment', async () => {
    const root = await fixture();
    const source = await peer(root);
    const originalKill = process.kill.bind(process);
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === 2147483647) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      return originalKill(pid, signal);
    });
    const stale = (id: string) => ({
      ...source.manifest,
      id,
      processId: 2147483647,
      updatedAt: Date.now() - 46_000,
      endpoint: join(root, `${id}.sock`),
    });
    for (let batch = 0; batch < 16; batch++) {
      await Promise.all(
        Array.from({ length: 64 }, (_, index) => {
          const id = `stale-${batch * 64 + index}`;
          return writeFile(join(root, `${id}.json`), JSON.stringify(stale(id)), { mode: 0o600 });
        })
      );
    }
    await writeFile(join(root, 'unrelated.json'), '{"unrelated":true}', { mode: 0o600 });
    await writeFile(join(root, 'not-private.json'), JSON.stringify(stale('not-private')), { mode: 0o644 });
    await symlink(join(root, 'unrelated.json'), join(root, 'linked.json'));
    const next = await peer(root);
    expect(await discoverPeers(root)).toEqual(expect.arrayContaining([source.identity, next.identity]));
    await expect(lstat(join(root, 'stale-0.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(join(root, 'stale-1023.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(root, 'unrelated.json'), 'utf8')).toBe('{"unrelated":true}');
    expect((await lstat(join(root, 'linked.json'))).isSymbolicLink()).toBe(true);
    expect((await lstat(join(root, 'not-private.json'))).mode & 0o777).toBe(0o644);
  });

  it('refuses a duplicate scoped saved thread and permits enrollment after the previous peer closes', async () => {
    const root = await fixture();
    const source = await peer(root);
    await expect(
      startPeerTransport({
        root,
        identity: identity({ threadId: source.identity.threadId }),
        handle: async () => ({ ok: true }),
      })
    ).rejects.toThrow(/saved thread/);
    await peer(root, identity({ threadId: source.identity.threadId, accountId: 'other' }));
    await peer(root, identity({ threadId: source.identity.threadId, projectId: 'other' }));
    const path = join(root, `${source.identity.id}.json`);
    await writeFile(path, JSON.stringify({ ...source.manifest, updatedAt: Date.now() - 46_000 }));
    expect((await discoverPeers(root)).some(peer => peer.id === source.identity.id)).toBe(false);
    await expect(
      startPeerTransport({
        root,
        identity: identity({ threadId: source.identity.threadId }),
        handle: async () => ({ ok: true }),
      })
    ).rejects.toThrow(/saved thread/);
    await source.close();
    await peer(root, identity({ threadId: source.identity.threadId }));
  });

  it('rejects an excessive directory instead of silently omitting live entries after unrelated files', async () => {
    const root = await fixture();
    const source = await peer(root);
    for (let batch = 0; batch < 32; batch++)
      await Promise.all(Array.from({ length: 128 }, (_, index) => mkdir(join(root, `inbox-${batch * 128 + index}`))));
    await expect(discoverPeers(root)).rejects.toThrow(/too many entries/);
    expect(await readFile(join(root, `${source.identity.id}.json`), 'utf8')).toContain(source.identity.id);
  });

  it('does not dispatch oversized messages and uses private temporary endpoints for long registry paths', async () => {
    const directory = await fixture();
    const root = join(directory, 'x'.repeat(90));
    const source = await peer(root);
    const target = await peer(root);
    expect(source.manifest.endpoint.length).toBeLessThan(104);
    expect(source.manifest.endpoint.startsWith(root)).toBe(false);
    expect(
      await callPeer(root, source.identity, target.identity.id, {
        type: 'send',
        message: { id: 'large', text: 'x'.repeat(65537), hops: 0, createdAt: 1, expiresAt: 2 },
      })
    ).toMatchObject({ ok: false });
    expect(target.handle).not.toHaveBeenCalled();
    expect(await callPeer(root, source.identity, target.identity.id, request)).toEqual({ ok: true });
  });

  it('bounds a lost response by deadline without replaying a dispatched request', async () => {
    vi.useFakeTimers();
    const root = await fixture();
    const source = await peer(root);
    let entered!: () => void;
    const accepted = new Promise<void>(done => {
      entered = done;
    });
    const handle = vi.fn(() => {
      entered();
      return new Promise<never>(() => undefined);
    });
    const target = await startPeerTransport({ root, identity: identity(), handle });
    cleanup.push(target.close);
    const response = callPeer(root, source.identity, target.manifest.id, request);
    await accepted;
    await vi.advanceTimersByTimeAsync(5001);
    expect(await response).toMatchObject({ ok: false, unknown: true });
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it('renews its own expired lease after a delayed heartbeat without exposing the stale lease to callers', async () => {
    vi.useFakeTimers();
    const root = await fixture();
    const source = await peer(root);
    const target = await peer(root);
    vi.setSystemTime(Date.now() + 60_000);
    await writeFile(
      join(root, `${source.identity.id}.json`),
      JSON.stringify({ ...source.manifest, updatedAt: Date.now() })
    );
    expect(await callPeer(root, source.identity, target.identity.id, request)).toMatchObject({ ok: false });
    expect(await callPeer(root, target.identity, source.identity.id, request)).toMatchObject({ ok: false });
    expect((await discoverPeers(root)).some(peer => peer.id === target.identity.id)).toBe(false);
    expect(target.handle).not.toHaveBeenCalled();
    const resumedAt = Date.now();
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.waitFor(async () => {
      const renewed = JSON.parse(await readFile(join(root, `${target.identity.id}.json`), 'utf8')) as {
        updatedAt: number;
      };
      expect(renewed.updatedAt).toBeGreaterThanOrEqual(resumedAt);
    });
    expect(await callPeer(root, source.identity, target.identity.id, request)).toEqual({ ok: true });
    expect(target.handle).toHaveBeenCalledTimes(1);
  });

  it('refuses heartbeat renewal over a replacement generation and preserves the replacement registration', async () => {
    vi.useFakeTimers();
    const root = await fixture();
    const source = await peer(root);
    const path = join(root, `${source.identity.id}.json`);
    const replacement = { ...source.manifest, generation: 'replacement-generation', token: 'f'.repeat(64) };
    await writeFile(path, JSON.stringify(replacement));
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.waitFor(() => expect(network.endpoints.has(source.manifest.endpoint)).toBe(false));
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      generation: 'replacement-generation',
      token: replacement.token,
    });
  });

  it('exchanges an authenticated request over isolated real Unix sockets', async () => {
    vi.resetModules();
    vi.doUnmock('node:net');
    vi.doUnmock('node:fs/promises');
    const actual = await import('./transport.js');
    const root = await fixture();
    const source = await actual.startPeerTransport({ root, identity: identity(), handle: async () => ({ ok: true }) });
    cleanup.push(source.close);
    const handle = vi.fn(async () => ({ ok: true as const }));
    const target = await actual.startPeerTransport({ root, identity: identity(), handle });
    cleanup.push(target.close);
    expect(await actual.callPeer(root, source.manifest, target.manifest.id, request)).toEqual({ ok: true });
    expect(handle).toHaveBeenCalledWith(
      {
        id: source.manifest.id,
        generation: source.manifest.generation,
        threadId: source.manifest.threadId,
        name: source.manifest.name,
        projectId: source.manifest.projectId,
        accountId: source.manifest.accountId,
      },
      request
    );
    const { createConnection } = await import('node:net');
    await new Promise<void>((done, reject) => {
      const forged = createConnection({ path: target.manifest.endpoint });
      forged.once('error', reject);
      forged.once('data', () => {
        forged.write(
          JSON.stringify({
            version: 1,
            senderId: source.manifest.id,
            generation: source.manifest.generation,
            request,
            proof: '0'.repeat(64),
          }) + '\n'
        );
      });
      forged.once('close', () => done());
    });
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it('removes a verified abandoned socket while preserving connected endpoints and replacement generations', async () => {
    vi.resetModules();
    vi.doUnmock('node:net');
    vi.doUnmock('node:fs/promises');
    const actual = await import('./transport.js');
    const { createServer } = await import('node:net');
    const { writeFileSync } = await import('node:fs');
    const root = await fixture();
    const source = await actual.startPeerTransport({ root, identity: identity(), handle: async () => ({ ok: true }) });
    cleanup.push(source.close);
    const originalKill = process.kill.bind(process);
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === 2147483647) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      return originalKill(pid, signal);
    });
    const orphan = createServer();
    const bound = join(root, 'old.sock');
    const endpoint = join(root, 'abandoned.sock');
    await new Promise<void>((done, reject) => {
      orphan.once('error', reject);
      orphan.listen(bound, done);
    });
    await chmod(bound, 0o600);
    await rename(bound, endpoint);
    await new Promise<void>(done => orphan.close(() => done()));
    const stale = {
      ...source.manifest,
      id: 'abandoned',
      endpoint,
      processId: 2147483647,
      updatedAt: Date.now() - 46_000,
    };
    await writeFile(join(root, 'abandoned.json'), JSON.stringify(stale), { mode: 0o600 });
    const connected = { ...stale, id: 'connected', endpoint: source.manifest.endpoint };
    await writeFile(join(root, 'connected.json'), JSON.stringify(connected), { mode: 0o600 });
    const replacingEndpoint = join(root, 'replacement.sock');
    const replacementPath = join(root, 'replacement.json');
    const old = { ...stale, id: 'replacement', endpoint: replacingEndpoint };
    const replacement = { ...old, generation: 'new-generation', updatedAt: Date.now(), processId: process.pid };
    const replacing = createServer(socket => {
      writeFileSync(replacementPath, JSON.stringify(replacement), { mode: 0o600 });
      socket.destroy();
    });
    await new Promise<void>((done, reject) => {
      replacing.once('error', reject);
      replacing.listen(replacingEndpoint, done);
    });
    await chmod(replacingEndpoint, 0o600);
    cleanup.push(() => new Promise<void>(done => replacing.close(() => done())));
    await writeFile(replacementPath, JSON.stringify(old), { mode: 0o600 });
    await actual.discoverPeers(root);
    await expect(lstat(endpoint)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(join(root, 'abandoned.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await lstat(source.manifest.endpoint)).isSocket()).toBe(true);
    expect((await lstat(replacingEndpoint)).isSocket()).toBe(true);
    expect(JSON.parse(await readFile(replacementPath, 'utf8'))).toMatchObject({ generation: 'new-generation' });
  });
});
