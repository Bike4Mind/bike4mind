import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, fork } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isPeerIdentity, isPeerName, isPeerRequest, type PeerIdentity, type PeerRequest } from './protocol.js';
import { callPeer, discoverPeers, ensurePeerRoot, preparePeerRoot, startPeerTransport } from './transport.js';

const network = vi.hoisted(() => ({ endpoints: new Map<string, unknown>(), home: undefined as string | undefined }));

vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => network.home ?? actual.homedir() };
});

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
  network.home = undefined;
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
  it('secures only the application-owned config and peers directories created under umask 002', async () => {
    const base = await fixture();
    network.home = join(base, 'home');
    await mkdir(network.home, { mode: 0o755 });
    const config = join(network.home, '.bike4mind');
    execFileSync(process.execPath, [
      '-e',
      'process.umask(2); require("node:fs").mkdirSync(process.argv[1], {recursive:true})',
      config,
    ]);
    const root = join(config, 'peers');
    expect((await lstat(config)).mode & 0o777).toBe(0o775);
    await expect(ensurePeerRoot(root)).rejects.toThrow(config);
    await preparePeerRoot(root);
    expect((await lstat(config)).mode & 0o777).toBe(0o700);
    expect((await lstat(root)).mode & 0o777).toBe(0o700);
    expect((await lstat(network.home)).mode & 0o777).toBe(0o755);
    await chmod(root, 0o775);
    await preparePeerRoot(root);
    expect((await lstat(root)).mode & 0o777).toBe(0o700);
    const unrelated = join(base, 'unrelated');
    await mkdir(unrelated);
    await chmod(unrelated, 0o775);
    await expect(preparePeerRoot(unrelated)).rejects.toThrow(unrelated);
    expect((await lstat(unrelated)).mode & 0o777).toBe(0o775);
    await chmod(network.home, 0o775);
    await expect(preparePeerRoot(root)).rejects.toThrow(network.home);
    expect((await lstat(network.home)).mode & 0o777).toBe(0o775);
    await chmod(network.home, 0o755);
    await rm(config, { recursive: true });
    const destination = join(base, 'linked-config');
    await mkdir(destination, { mode: 0o755 });
    await symlink(destination, config);
    await expect(preparePeerRoot(root)).rejects.toThrow(/symbolic links/);
    expect((await lstat(destination)).mode & 0o777).toBe(0o755);
  });

  it('rejects unsafe advertised names and unknown request or message keys', () => {
    for (const name of [
      '',
      '  ',
      'newline\nname',
      'line\u2028name',
      'line\u2029name',
      'hidden\u202ename',
      'hidden\u061cname',
      'hidden\u200ename',
      'hidden\u200fname',
      'x'.repeat(101),
    ]) {
      expect(isPeerName(name)).toBe(false);
      expect(isPeerIdentity(identity({ name }))).toBe(false);
    }
    expect(isPeerName('A valid name')).toBe(true);
    expect(isPeerRequest({ type: 'presence', prompt: 'extra' })).toBe(false);
    expect(isPeerRequest({ type: 'status', messageId: 'id', context: 'extra' })).toBe(false);
    expect(
      isPeerRequest({
        type: 'send',
        message: { id: 'id', text: 'hello', hops: 0, createdAt: 1, expiresAt: 2, environment: 'extra' },
      })
    ).toBe(false);
    expect(
      isPeerRequest({
        type: 'send',
        message: { id: 'id', text: 'hello', hops: 0, createdAt: 1, expiresAt: 2 },
        model: 'extra',
      })
    ).toBe(false);
  });
  it.each(['stat', 'write'] as const)(
    'cleans only its owned enrollment lock after a transient %s failure',
    async phase => {
      const root = await fixture();
      const value = identity();
      const files = await import('node:fs/promises');
      const originalOpen = files.open;
      const failure = new Error(`enrollment ${phase} failed`);
      const closed = vi.fn();
      const open = vi.spyOn(files, 'open').mockImplementationOnce(async (file, flags, mode) => {
        expect(String(file)).toMatch(/enrollments\/[^/]+\.lock$/);
        const handle = await originalOpen(file, flags, mode);
        const close = handle.close.bind(handle);
        vi.spyOn(handle, 'close').mockImplementation(async () => {
          closed();
          await close();
        });
        if (phase === 'stat') vi.spyOn(handle, 'stat').mockRejectedValueOnce(failure);
        else vi.spyOn(handle, 'writeFile').mockRejectedValueOnce(failure);
        return handle;
      });
      await expect(startPeerTransport({ root, identity: value, handle: async () => ({ ok: true }) })).rejects.toBe(
        failure
      );
      expect(closed).toHaveBeenCalledTimes(1);
      expect(await files.readdir(join(root, 'enrollments'))).toEqual([]);
      open.mockRestore();
      await peer(root, value);
    }
  );

  it('preserves a replacement enrollment file when initialization of its original inode fails', async () => {
    const root = await fixture();
    const files = await import('node:fs/promises');
    const originalOpen = files.open;
    const failure = new Error('enrollment write failed');
    let replacement = '';
    vi.spyOn(files, 'open').mockImplementationOnce(async (file, flags, mode) => {
      const handle = await originalOpen(file, flags, mode);
      replacement = String(file);
      vi.spyOn(handle, 'writeFile').mockImplementationOnce(async () => {
        await files.rename(replacement, `${replacement}.retired`);
        await files.writeFile(replacement, 'replacement owner', { mode: 0o600 });
        throw failure;
      });
      return handle;
    });
    await expect(startPeerTransport({ root, identity: identity(), handle: async () => ({ ok: true }) })).rejects.toBe(
      failure
    );
    expect(await readFile(replacement, 'utf8')).toBe('replacement owner');
  });

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

  it('recovers expired absent endpoints despite reused PIDs or EPERM and fences the old manifest', async () => {
    const root = await fixture();
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('denied'), { code: 'EPERM' });
    });
    for (const [index, processId] of [process.pid, 2147483647].entries()) {
      const old = identity();
      const manifest = {
        ...old,
        version: 1,
        processId,
        token: 'a'.repeat(64),
        endpoint: join(root, `${old.id}.sock`),
        updatedAt: Date.now() - 60_000,
      };
      const path = join(root, `${old.id}.json`);
      await writeFile(path, JSON.stringify(manifest), { mode: 0o600 });
      await peer(root, identity({ threadId: old.threadId, name: `Replacement ${index}` }));
      await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(process.kill).not.toHaveBeenCalled();
  });

  it('gives scoped recovery instructions for an uncertain enrollment lock without removing it', async () => {
    const root = await fixture();
    const owner = identity();
    const directory = await ensurePeerRoot(join(root, 'enrollments'));
    const key = createHash('sha256')
      .update(JSON.stringify([owner.accountId, owner.projectId, owner.threadId]))
      .digest('hex');
    const file = join(directory, `${key}.lock`);
    const contents = JSON.stringify({ id: 'old', generation: 'uncertain', processId: 2147483647 });
    await writeFile(file, contents, { mode: 0o600 });
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(6000);
    const startup = startPeerTransport({ root, identity: owner, handle: async () => ({ ok: true }) });
    await expect(startup).rejects.toThrow(file);
    await expect(startup).rejects.toThrow(/verifying no peer enrollment/);
    expect(await readFile(file, 'utf8')).toBe(contents);
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

  it('renews ownership after a backward clock correction while callers reject future leases', async () => {
    vi.useFakeTimers();
    const root = await fixture();
    const onClosed = vi.fn();
    const target = await startPeerTransport({
      root,
      identity: identity(),
      handle: async () => ({ ok: true }),
      onClosed,
    });
    cleanup.push(target.close);
    vi.setSystemTime(Date.now() - 60_000);
    const source = await peer(root);
    expect((await discoverPeers(root)).some(peer => peer.id === target.manifest.id)).toBe(false);
    expect(await callPeer(root, source.identity, target.manifest.id, request)).toMatchObject({ ok: false });
    const resumed = Date.now();
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.waitFor(async () => {
      const manifest = JSON.parse(await readFile(join(root, `${target.manifest.id}.json`), 'utf8')) as {
        updatedAt: number;
      };
      expect(manifest.updatedAt).toBeGreaterThanOrEqual(resumed);
      expect(manifest.updatedAt).toBeLessThanOrEqual(Date.now());
    });
    expect(await callPeer(root, source.identity, target.manifest.id, request)).toEqual({ ok: true });
    await target.close();
    expect(onClosed).not.toHaveBeenCalled();
  });

  it('notifies once on a terminal heartbeat failure but not on normal closure', async () => {
    vi.useFakeTimers();
    const root = await fixture();
    const onClosed = vi.fn();
    const target = await startPeerTransport({
      root,
      identity: identity(),
      handle: async () => ({ ok: true }),
      onClosed,
    });
    cleanup.push(target.close);
    const path = join(root, `${target.manifest.id}.json`);
    await writeFile(path, JSON.stringify({ ...target.manifest, generation: 'replacement' }));
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.waitFor(() => expect(onClosed).toHaveBeenCalledTimes(1));
    expect(onClosed).toHaveBeenCalledWith(expect.stringContaining('registration changed'));
    await target.close();
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it('rejects oversized or unknown response fields before exposing a receipt', async () => {
    const root = await fixture();
    const source = await peer(root);
    for (const extra of [{ result: 'x'.repeat(12289) }, { error: 'x'.repeat(1025) }, { context: 'unrequested' }]) {
      const target = identity();
      const transport = await startPeerTransport({
        root,
        identity: target,
        handle: async () => ({
          ok: true,
          receipt: {
            id: 'message',
            senderId: source.identity.id,
            recipientId: target.id,
            status: 'completed',
            createdAt: 1,
            expiresAt: 2,
            hops: 0,
            ...extra,
          },
        }),
      });
      cleanup.push(transport.close);
      expect(await callPeer(root, source.identity, target.id, request)).toMatchObject({ ok: false, unknown: true });
    }
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

  it('atomically enrolls only one process for the same account, project and saved thread', async () => {
    const directory = await fixture();
    const registry = join(directory, 'registry');
    const protocol = await readFile(new URL('./protocol.ts', import.meta.url), 'utf8');
    const transport = await readFile(new URL('./transport.ts', import.meta.url), 'utf8');
    await mkdir(join(directory, 'node_modules'), { mode: 0o700 });
    await symlink(
      fileURLToPath(new URL('../../node_modules/zod', import.meta.url)),
      join(directory, 'node_modules', 'zod'),
      'dir'
    );
    await writeFile(join(directory, 'protocol.ts'), protocol);
    await writeFile(join(directory, 'transport.ts'), transport.replace("'./protocol.js'", "'./protocol.ts'"));
    const script = join(directory, 'enroll.mts');
    await writeFile(
      script,
      `
      import { randomUUID } from 'node:crypto';
      import { startPeerTransport } from './transport.ts';
      try {
        const server = await startPeerTransport({
          root: process.argv[2],
          identity: { id: randomUUID(), generation: randomUUID(), threadId: process.argv[3], name: 'Fixture', accountId: 'account', projectId: 'project' },
          handle: async () => ({ ok: true })
        });
        process.once('message', async () => { await server.close(); process.exit(0); });
        process.send({ status: 'fulfilled' });
      } catch (error) {
        process.send({ status: 'rejected', error: error.message }, () => process.exit(0));
      }
    `
    );
    const threadId = randomUUID();
    const children = [
      fork(script, [registry, threadId], { execArgv: [], silent: true }),
      fork(script, [registry, threadId], { execArgv: [], silent: true }),
    ];
    cleanup.push(async () => {
      await Promise.all(
        children.map(
          child =>
            new Promise<void>(done => {
              if (child.exitCode !== null || child.signalCode !== null) {
                done();
                return;
              }
              child.once('exit', () => done());
              child.kill('SIGTERM');
            })
        )
      );
    });
    const results = await Promise.all(
      children.map(
        child =>
          new Promise<{ status: string; error?: string }>((done, reject) => {
            let received = false;
            child.once('message', value => {
              received = true;
              done(value as { status: string; error?: string });
            });
            child.once('error', reject);
            child.once('exit', code => {
              if (!received) reject(new Error(`Enrollment fixture exited early: ${code}`));
            });
          })
      )
    );
    expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(results.find(result => result.status === 'rejected')?.error).toContain('saved thread');
    for (const [index, child] of children.entries()) if (results[index].status === 'fulfilled') child.send('close');
    await Promise.all(
      children.map(
        child =>
          new Promise<void>(done => {
            if (child.exitCode !== null || child.signalCode !== null) done();
            else child.once('exit', () => done());
          })
      )
    );
  });
});
