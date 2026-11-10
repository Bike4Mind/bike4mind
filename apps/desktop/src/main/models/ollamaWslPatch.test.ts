import { mkdir, mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises';
import { endianness, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createOllamaWslPatchProbe,
  decodeProcNetAddress,
  fileMarkers,
  servingOllamaPid,
  WSL_MEMORY_PATCH_MARKERS,
} from './ollamaWslPatch';

const OLLAMA_URL = 'http://127.0.0.1:11434';
const LOCALHOST_URL = 'http://localhost:11434';
const SHARED = 'OLLAMA_WSL_SHARED_GPU_MEMORY';
const SPILL = 'OLLAMA_WSL_GPU_SPILL';
const stockImage = () => Buffer.concat([Buffer.from('\x7fELF'), Buffer.alloc(4096, 7), Buffer.from('OLLAMA_HOST')]);
const imageWith = (marker: string) =>
  Buffer.concat([Buffer.from('\x7fELF'), Buffer.alloc(2048, 7), Buffer.from(`${marker}OLLAMA_HOST`)]);

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ollama-wsl-patch-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const later = () => Date.now() + 10_000;

describe('fileMarkers', () => {
  it.each(WSL_MEMORY_PATCH_MARKERS)('finds %s', async marker => {
    const path = join(root, 'ollama');
    await writeFile(path, imageWith(marker));
    expect(await fileMarkers(path, WSL_MEMORY_PATCH_MARKERS, later())).toEqual(new Set([marker]));
  });

  it('reads a release build to the end and finds none', async () => {
    const path = join(root, 'ollama');
    await writeFile(path, stockImage());
    expect(await fileMarkers(path, WSL_MEMORY_PATCH_MARKERS, later())).toEqual(new Set());
  });

  it('finds a marker split across two reads', async () => {
    const path = join(root, 'ollama');
    await writeFile(path, Buffer.from('abcdeOLLAMA_WSL_GPU_SPILLxyz'));
    expect(await fileMarkers(path, WSL_MEMORY_PATCH_MARKERS, later(), 8)).toEqual(new Set([SPILL]));
    expect(await fileMarkers(path, ['SPILLx', 'SPILLy'], later(), 3)).toEqual(new Set(['SPILLx']));
  });

  it('is unknown for a file it cannot open', async () => {
    expect(await fileMarkers(join(root, 'missing'), WSL_MEMORY_PATCH_MARKERS, later())).toBeNull();
  });

  it('is unknown once the deadline passes before the end', async () => {
    const path = join(root, 'ollama');
    await writeFile(path, stockImage());
    expect(await fileMarkers(path, WSL_MEMORY_PATCH_MARKERS, Date.now() - 1)).toBeNull();
  });

  it('gives up on an open that blocks past the deadline, and closes the file if it opens later', async () => {
    vi.useFakeTimers();
    try {
      let release: (handle: unknown) => void = () => {};
      const openFile = vi.fn(() => new Promise(resolve => (release = resolve))) as unknown as typeof open;
      const result = fileMarkers('/blocked', WSL_MEMORY_PATCH_MARKERS, Date.now() + 50, undefined, openFile);
      await vi.advanceTimersByTimeAsync(50);
      expect(await result).toBeNull();
      const close = vi.fn(async () => undefined);
      release({ close, read: vi.fn() });
      await vi.advanceTimersByTimeAsync(0);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('decodeProcNetAddress', () => {
  it.each([
    ['0100007F', true, '127.0.0.1'],
    ['7F000001', false, '127.0.0.1'],
    ['00000000', true, '0.0.0.0'],
    ['00000000000000000000000001000000', true, '::1'],
    ['00000000000000000000000000000001', false, '::1'],
    ['00000000000000000000000000000000', true, '::'],
    ['0000000000000000FFFF00000100007F', true, '::ffff:7f00:1'],
  ])('reads %s (little-endian %s) as %s', (hex, littleEndian, address) => {
    expect(decodeProcNetAddress(hex, littleEndian)).toBe(address);
  });

  it.each(['', '0100007', 'XYZ0007F', '0100007F00'])('rejects %j', hex => {
    expect(decodeProcNetAddress(hex, true)).toBeNull();
  });
});

// A /proc tree: listening sockets in net/tcp and tcp6, and processes with their descriptors, binary and variables.
const LITTLE = endianness() === 'LE';
const hostOrder = (bytes: number[]) =>
  Array.from({ length: bytes.length / 4 }, (_, word) => {
    const group = bytes.slice(word * 4, word * 4 + 4);
    return (LITTLE ? group.reverse() : group).map(byte => byte.toString(16).padStart(2, '0')).join('');
  })
    .join('')
    .toUpperCase();
const V6_ANY = Array<number>(16).fill(0);
const V6_LOOPBACK = [...Array<number>(15).fill(0), 1];
const V6_MAPPED_LOOPBACK = [...Array<number>(10).fill(0), 255, 255, 127, 0, 0, 1];

interface Socket {
  /** Dotted for IPv4; 16 bytes for IPv6. */
  address: string | number[];
  port: number;
  inode: number;
  state?: string;
}

async function writeSockets(sockets: Socket[]) {
  await mkdir(join(root, 'proc', 'net'), { recursive: true });
  const header = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
  for (const table of ['tcp', 'tcp6'] as const) {
    const lines = sockets
      .filter(socket => (typeof socket.address === 'string') === (table === 'tcp'))
      .map((socket, index) => {
        const local =
          typeof socket.address === 'string'
            ? hostOrder(socket.address.split('.').map(Number))
            : hostOrder(socket.address);
        const remote = table === 'tcp' ? '00000000:0000' : `${'0'.repeat(32)}:0000`;
        const port = socket.port.toString(16).toUpperCase().padStart(4, '0');
        const state = socket.state ?? '0A';
        return `  ${index}: ${local}:${port} ${remote} ${state} 00000000:00000000 00:00000000 00000000  1000        0 ${socket.inode} 1 0 100 0 0 10 0`;
      });
    await writeFile(join(root, 'proc', 'net', table), [header, ...lines, ''].join('\n'));
  }
}

interface Server {
  pid: number;
  comm?: string;
  argv?: string[];
  image: Buffer;
  environ?: Record<string, string> | null;
  sockets?: number[];
  container?: boolean;
  started?: number;
  /** false: its descriptors cannot be read, as another user's. */
  fdReadable?: boolean;
}

async function writeServer(server: Server) {
  const dir = join(root, 'proc', String(server.pid));
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const comm = server.comm ?? 'ollama';
  const argv = server.argv ?? ['/opt/ollama/bin/ollama', 'serve'];
  const env = server.environ === undefined ? { OLLAMA_HOST: '127.0.0.1:11434' } : server.environ;
  // Fields 3 to 21 of /proc/<pid>/stat, then the start time and one more.
  const fields = ['S', 1, server.pid, server.pid, 0, -1, 4194560, 100, 0, 0, 0, 1, 1, 0, 0, 20, 0, 12, 0];
  await Promise.all([
    writeFile(join(dir, 'comm'), `${comm}\n`),
    writeFile(join(dir, 'cmdline'), `${argv.join('\0')}\0`),
    writeFile(join(dir, 'exe'), server.image),
    writeFile(join(dir, 'cgroup'), server.container ? '0::/system.slice/docker-abc.scope\n' : '0::/user.slice\n'),
    writeFile(join(dir, 'stat'), `${server.pid} (${comm}) ${[...fields, server.started ?? 5000, 99].join(' ')}\n`),
    env === null
      ? Promise.resolve()
      : writeFile(
          join(dir, 'environ'),
          Object.entries(env)
            .map(([key, value]) => `${key}=${value}\0`)
            .join('')
        ),
  ]);
  if (server.fdReadable === false) return;
  await mkdir(join(dir, 'fd'));
  await symlink('/dev/null', join(dir, 'fd', '0'));
  for (const [index, inode] of (server.sockets ?? []).entries()) {
    await symlink(`socket:[${inode}]`, join(dir, 'fd', String(index + 3)));
  }
}

const LISTENING: Socket = { address: '127.0.0.1', port: 11434, inode: 5001 };
const ON_V6_LOOPBACK: Socket = { address: V6_LOOPBACK, port: 11434, inode: 5002 };

describe('servingOllamaPid', () => {
  it('picks the server holding the socket Desktop reaches, not a container serving the same port inside', async () => {
    await writeSockets([LISTENING]);
    await writeServer({ pid: 100, image: imageWith(SHARED), sockets: [5001] });
    // Its socket is in the container's own network namespace, so the host table does not list it.
    await writeServer({
      pid: 200,
      image: stockImage(),
      container: true,
      environ: { OLLAMA_HOST: '0.0.0.0:11434' },
      sockets: [9001],
    });
    expect(await servingOllamaPid(OLLAMA_URL, root)).toBe(100);
  });

  it.each([
    ['an IPv6 wildcard', { address: V6_ANY, port: 11434, inode: 5002 }, OLLAMA_URL],
    ['an IPv4-mapped loopback', { address: V6_MAPPED_LOOPBACK, port: 11434, inode: 5002 }, OLLAMA_URL],
    ['the IPv4 wildcard', { address: '0.0.0.0', port: 11434, inode: 5002 }, OLLAMA_URL],
    ['the IPv6 loopback, reached by localhost', ON_V6_LOOPBACK, LOCALHOST_URL],
  ])('matches a listener on %s', async (_case, socket: Socket, url) => {
    await writeSockets([socket]);
    await writeServer({ pid: 100, image: stockImage(), sockets: [5002] });
    expect(await servingOllamaPid(url, root)).toBe(100);
  });

  it.each([
    ['the listener is on another port', [{ ...LISTENING, port: 11435 }], OLLAMA_URL],
    ['the only socket on the port is not listening', [{ ...LISTENING, state: '01' }], OLLAMA_URL],
    ['the listener is on the IPv6 loopback and the address is IPv4', [{ ...ON_V6_LOOPBACK, inode: 5001 }], OLLAMA_URL],
    ['the address is a host name other than localhost', [LISTENING], 'http://ollama.internal:11434'],
    ['the address does not parse', [LISTENING], 'not a url'],
  ])('finds none when %s', async (_case, sockets: Socket[], url) => {
    await writeSockets(sockets);
    await writeServer({ pid: 100, image: stockImage(), sockets: [5001] });
    expect(await servingOllamaPid(url, root)).toBeNull();
  });

  it('finds none when two servers each hold a socket the address reaches', async () => {
    await writeSockets([LISTENING, ON_V6_LOOPBACK]);
    await writeServer({ pid: 100, image: stockImage(), sockets: [5001] });
    await writeServer({ pid: 300, image: imageWith(SHARED), sockets: [5002] });
    expect(await servingOllamaPid(LOCALHOST_URL, root)).toBeNull();
  });

  it('finds none when a server holds only some of the sockets the address reaches', async () => {
    await writeSockets([LISTENING, ON_V6_LOOPBACK]);
    await writeServer({ pid: 100, image: stockImage(), sockets: [5001] });
    expect(await servingOllamaPid(LOCALHOST_URL, root)).toBeNull();
  });

  it.each([
    ['another program, such as a port proxy', { comm: 'docker-proxy', argv: ['docker-proxy', '-host-port', '11434'] }],
    ['an Ollama that is not the server', { argv: ['/opt/ollama/bin/ollama', 'runner'] }],
    ["a server whose descriptors cannot be read, as another user's", { fdReadable: false }],
  ])('finds none when the socket is held by %s', async (_case, holder: Partial<Server>) => {
    await writeSockets([LISTENING]);
    await writeServer({ pid: 100, image: stockImage(), sockets: [5001], ...holder });
    expect(await servingOllamaPid(OLLAMA_URL, root)).toBeNull();
  });

  it('finds none without the socket tables', async () => {
    await writeServer({ pid: 100, image: stockImage(), sockets: [5001] });
    expect(await servingOllamaPid(OLLAMA_URL, root)).toBeNull();
  });
});

describe('createOllamaWslPatchProbe', () => {
  async function serving(server: Omit<Server, 'pid' | 'sockets'>) {
    await writeSockets([LISTENING]);
    await writeServer({ pid: 100, sockets: [5001], ...server });
  }

  it.each([
    ['declares the current setting', imageWith(SHARED), true],
    ['declares the earlier setting', imageWith(SPILL), true],
    ['is a release build', stockImage(), false],
  ])('reads a server whose binary %s', async (_case, image, patched) => {
    await serving({ image });
    expect(await createOllamaWslPatchProbe({ root })(OLLAMA_URL)).toMatchObject({ patched });
  });

  it.each([
    ['0', false],
    ['false', false],
    [' "False" ', false],
    ['1', true],
    ['', true],
    ['not a bool', true],
  ])('reads OLLAMA_WSL_SHARED_GPU_MEMORY=%j as the fix being on: %s', async (value, patched) => {
    await serving({ image: imageWith(SHARED), environ: { OLLAMA_HOST: '127.0.0.1:11434', [SHARED]: value } });
    expect(await createOllamaWslPatchProbe({ root })(OLLAMA_URL)).toMatchObject({ patched });
  });

  it('keeps the first of two assignments, as Go does', async () => {
    await serving({ image: imageWith(SHARED), environ: {} });
    await writeFile(join(root, 'proc', '100', 'environ'), `${SHARED}=0\0${SHARED}=1\0`);
    expect(await createOllamaWslPatchProbe({ root })(OLLAMA_URL)).toMatchObject({ patched: false });
  });

  it('ignores OLLAMA_WSL_SHARED_GPU_MEMORY in a build with only the earlier setting', async () => {
    await serving({ image: imageWith(SPILL), environ: { [SHARED]: '0' } });
    expect(await createOllamaWslPatchProbe({ root })(OLLAMA_URL)).toMatchObject({ patched: true });
  });

  it('keeps the binary read when the environment cannot be read', async () => {
    await serving({ image: imageWith(SHARED), environ: null });
    expect(await createOllamaWslPatchProbe({ root })(OLLAMA_URL)).toMatchObject({ patched: true });
  });

  it('is unknown when the server cannot be told', async () => {
    await writeSockets([LISTENING]);
    expect(await createOllamaWslPatchProbe({ root })(OLLAMA_URL)).toBeNull();
  });

  it('is unknown when the process lookup fails or does not answer in time', async () => {
    const failing = createOllamaWslPatchProbe({ root, serverPid: async () => Promise.reject(new Error('EMFILE')) });
    expect(await failing(OLLAMA_URL)).toBeNull();
    vi.useFakeTimers();
    try {
      const hung = createOllamaWslPatchProbe({ root, serverPid: () => new Promise(() => {}), timeoutMs: 20 });
      const answer = hung(OLLAMA_URL);
      await vi.advanceTimersByTimeAsync(20);
      expect(await answer).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('is unknown, with the server named, when its binary cannot be read', async () => {
    await serving({ image: stockImage() });
    await rm(join(root, 'proc', '100', 'exe'));
    await mkdir(join(root, 'proc', '100', 'exe'));
    const build = await createOllamaWslPatchProbe({ root })(OLLAMA_URL);
    expect(build).toMatchObject({ patched: null });
    expect(build?.server).toMatch(/^100:5000:/);
  });

  it('shares one read between listings asked at once', async () => {
    await serving({ image: imageWith(SHARED) });
    const serverPid = vi.fn((url: string) => servingOllamaPid(url, root));
    const probe = createOllamaWslPatchProbe({ root, serverPid });
    const [first, second] = await Promise.all([probe(OLLAMA_URL), probe(OLLAMA_URL)]);
    expect(first).toEqual(second);
    expect(serverPid).toHaveBeenCalledTimes(1);
  });

  it('answers a later listing from the last read while the same process serves', async () => {
    await serving({ image: imageWith(SHARED) });
    const serverPid = vi.fn((url: string) => servingOllamaPid(url, root));
    const probe = createOllamaWslPatchProbe({ root, serverPid });
    const first = await probe(OLLAMA_URL);
    expect(await probe(OLLAMA_URL)).toEqual(first);
    expect(serverPid).toHaveBeenCalledTimes(1);
  });

  it('reads again once Ollama restarts on another binary', async () => {
    await serving({ image: imageWith(SHARED) });
    const probe = createOllamaWslPatchProbe({ root });
    const first = await probe(OLLAMA_URL);
    expect(first).toMatchObject({ patched: true });
    await rm(join(root, 'proc', '100'), { recursive: true });
    await writeSockets([{ ...LISTENING, inode: 5003 }]);
    await writeServer({ pid: 101, sockets: [5003], image: stockImage(), started: 9000 });
    const second = await probe(OLLAMA_URL);
    expect(second).toMatchObject({ patched: false });
    expect(second?.server).not.toBe(first?.server);
  });

  it('reads again when the same pid runs another binary', async () => {
    await serving({ image: imageWith(SHARED) });
    const probe = createOllamaWslPatchProbe({ root });
    expect(await probe(OLLAMA_URL)).toMatchObject({ patched: true });
    await writeFile(join(root, 'proc', '100', 'exe'), stockImage());
    expect(await probe(OLLAMA_URL)).toMatchObject({ patched: false });
  });
});
