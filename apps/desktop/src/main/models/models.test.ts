import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import {
  clearsCap,
  isLinuxStoreDir,
  isWslHost,
  parseC2cMode,
  partialLoad,
  probeIntegratedGpu,
  releaseCapsWslGpu,
  runsInWsl,
  wslGpuCapWarning,
} from './wslGpuCap';
import { mkdir, mkdtemp, open, rm, symlink, writeFile, truncate } from 'node:fs/promises';
import { endianness, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createOllamaWslPatchProbe,
  decodeProcNetAddress,
  fileMarkers,
  servingOllamaPid,
  WSL_MEMORY_PATCH_MARKERS,
} from './ollamaWslPatch';
import { loadedStateOf, loadedStateTarget } from './loadedState';
import {
  loadCuratedManifest as loadPackageCuratedManifest,
  curatedLibrary,
  curatedListing,
  curatedPins,
  curatedSource,
  ollamaRefAliases,
  PRODUCTION_CURATED_KEYS,
  type LoadedModel,
  type HubModelDetail,
} from '@bike4mind/local-models';
import { AUTO_LOCAL_CONTEXT } from '@shared/localContextSetting';
import { unifiedMachine } from '../chat/fitStub.testHelper';
import { HardwareProbe, localContextSizing } from '../chat/localContextSizing';
import { installedProjectorBytes, pinnedProjectorSizes } from './projectorBytes';
import { CapabilityLedger } from '../chat/capabilities/CapabilityLedger';
import { PullLedger } from './pullLedger';
import { serverHardware, withEnteredSpecs } from './enteredHardware';
import { createHash } from 'node:crypto';
import { catalogSampling } from './catalogSampling';
import { loadCuratedManifest, olderThan } from './loadCuratedManifest';
import { BUNDLED_CURATED_TEXT } from './curated/bundled';
import { curatedDevKey, curatedDevOverrides } from './curated/devKey';
import { openedAs, sealedAs, versionedCipher } from '../secrets/versionedCipher.testHelper';
import { HuggingFaceTokenStore } from './HuggingFaceTokenStore';
import { IPC_CHANNELS } from '@shared/ipc';
import { registerModelsIpc } from './ipc';
import { ModelHubService, type StartedPull, type ModelRuntimePort } from './ModelHubService';
import type { ModelPull } from '@shared/models';
import type { HardwareProfile } from '@bike4mind/common';
import type { ModelServerSpecs, ModelServerManagement } from '@shared/modelServers';
import paramsLayers from './ollamaParamsLayers.fixture.json';

describe('wslGpuCap', () => {
  const GIB = 1024 ** 3;

  const model = (name: string, sizeGib: number, gpuGib: number): LoadedModel => ({
    name,
    sizeBytes: sizeGib * GIB,
    vramBytes: gpuGib * GIB,
    contextLength: 131072,
    expiresAt: null,
  });

  describe('parseC2cMode', () => {
    it('reads a GPU attached to the CPU, beside the NPU Windows lists with no C2C mode', () => {
      expect(parseC2cMode('Enabled\r\n[N/A]\r\n')).toBe(true);
      expect(parseC2cMode('Enabled\n')).toBe(true);
    });

    it('reads a discrete GPU as not integrated', () => {
      expect(parseC2cMode('[N/A]\n')).toBe(false);
      expect(parseC2cMode('Disabled\n[N/A]\n')).toBe(false);
    });

    it('cannot say from empty output or an nvidia-smi that does not know the field', () => {
      expect(parseC2cMode('')).toBeNull();
      expect(parseC2cMode('Field "c2c.mode" is not a valid field to query.\n')).toBeNull();
    });
  });

  describe('probeIntegratedGpu', () => {
    it('asks nvidia-smi for the C2C mode alone, so an older nvidia-smi cannot fail the hardware probe', async () => {
      const exec = vi.fn(async () => ({ stdout: 'Enabled\n' }));
      expect(await probeIntegratedGpu(exec)).toBe(true);
      expect(exec).toHaveBeenCalledWith('nvidia-smi', ['--query-gpu=c2c.mode', '--format=csv,noheader']);
    });

    it('cannot say when nvidia-smi fails', async () => {
      expect(await probeIntegratedGpu(async () => Promise.reject(new Error('exit 2')))).toBeNull();
    });
  });

  describe('runsInWsl', () => {
    it('reads the WSL environment or kernel', () => {
      expect(runsInWsl({ WSL_DISTRO_NAME: 'Ubuntu' }, null)).toBe(true);
      expect(runsInWsl({ WSL_INTEROP: '/run/WSL/1_interop' }, null)).toBe(true);
      expect(runsInWsl({}, 'Linux version 6.18.33.2-microsoft-standard-WSL2 (root@host)')).toBe(true);
      expect(runsInWsl({}, 'Linux version 6.8.0-45-generic (buildd@lcy02)')).toBe(false);
      expect(runsInWsl({}, null)).toBe(false);
    });
  });

  describe('isWslHost', () => {
    const WSL_KERNEL = 'Linux version 6.18.33.2-microsoft-standard-WSL2 (root@host)';
    const NATIVE_KERNEL = 'Linux version 6.8.0-45-generic (buildd@lcy02)';

    it.each([
      ['Windows', 'win32', {}, null, true],
      ['WSL, from its environment', 'linux', { WSL_DISTRO_NAME: 'Ubuntu' }, null, true],
      ['WSL, from its kernel', 'linux', {}, WSL_KERNEL, true],
      ['native Linux', 'linux', {}, NATIVE_KERNEL, false],
      ['Linux with an unreadable kernel version', 'linux', {}, null, false],
      ['macOS', 'darwin', {}, null, false],
    ] as const)('reads %s', (_case, platform, env, kernel, expected) => {
      expect(isWslHost(platform, env, () => kernel)).toBe(expected);
    });

    it('reads /proc/version only on Linux', () => {
      const procVersion = vi.fn(() => WSL_KERNEL);
      isWslHost('win32', {}, procVersion);
      isWslHost('darwin', { WSL_DISTRO_NAME: 'Ubuntu' }, procVersion);
      expect(procVersion).not.toHaveBeenCalled();
    });
  });

  describe('releaseCapsWslGpu', () => {
    it.each(['0.30.0-rc0', '0.30.0', '0.35.2', '0.40.11', '0.40.15-rc2', '0.40.15', ' 0.40.15\n', 'v0.40.15'])(
      'holds a WSL integrated GPU to the VM for release %j',
      version => expect(releaseCapsWslGpu(version)).toBe(true)
    );

    it.each([
      ['a release newer than the ones checked, which may carry the upstream fix', '0.40.16'],
      ['a release candidate past the ones checked', '0.40.16-rc0'],
      ['a later major release', '1.0.0'],
      ['a release from before the scheduler limit', '0.24.0'],
      ['the last release before the first known to limit', '0.29.9'],
      ['a patch release of 0.29 with a candidate suffix', '0.29.99-rc1'],
      ['an unstamped source build', '0.0.0'],
      ['a source build stamped by git describe', '0.40.13-11-g3f9c2d1'],
      ['a dirty source build at a tag', '0.40.15-0-g1a2b3c4-dirty'],
      ['a version that is not one', 'unknown'],
      ['an empty version', ''],
      ['no version', null],
    ])('cannot say for %s', (_case, version) => expect(releaseCapsWslGpu(version)).toBe(false));
  });

  describe('wslGpuCapWarning', () => {
    it('names the release Ollama reported, or the load that showed the limit', () => {
      expect(wslGpuCapWarning(' 0.40.15 ')).toMatch(/^Ollama 0\.40\.15 in WSL limits GPU memory to the WSL virtual/);
      expect(wslGpuCapWarning(null)).toMatch(/^It looks like Ollama in WSL limits GPU memory/);
      expect(wslGpuCapWarning(null)).toMatch(/runs partly on the CPU and replies slowly\. Giving WSL more memory/);
    });

    it('is plain ASCII', () => {
      expect(wslGpuCapWarning('0.40.15')).toMatch(/^[\x20-\x7e]+$/);
    });
  });

  describe('isLinuxStoreDir', () => {
    it('tells a Linux model folder from a Windows one', () => {
      expect(isLinuxStoreDir('/usr/share/ollama/.ollama/models')).toBe(true);
      expect(isLinuxStoreDir('C:\\Users\\me\\.ollama\\models')).toBe(false);
      expect(isLinuxStoreDir('\\\\wsl.localhost\\Ubuntu\\home\\me\\.ollama\\models')).toBe(false);
      expect(isLinuxStoreDir(null)).toBe(false);
    });
  });

  // Dedicated GPU memory differs per machine and per firmware setting; nothing here may assume one size.
  describe.each([24, 64, 72, 80, 96])('partialLoad with %i GiB of usable GPU memory', usableGib => {
    const usable = usableGib * GIB;

    it('finds a model that fits the GPU held partly on the CPU', () => {
      const capped = model('big:q8', usableGib * 0.6, usableGib * 0.35);
      expect(partialLoad([model('small:q4', 2, 2), capped], usable)).toEqual({
        model: 'big:q8',
        sizeBytes: capped.sizeBytes,
        gpuBytes: capped.vramBytes,
      });
    });

    it('ignores a model fully on the GPU, or short of it only by rounding', () => {
      expect(partialLoad([model('big:q8', usableGib * 0.6, usableGib * 0.6)], usable)).toBeNull();
      expect(partialLoad([model('big:q8', usableGib * 0.6, usableGib * 0.6 * 0.95)], usable)).toBeNull();
    });

    it('ignores a model larger than the GPU, which runs partly on the CPU anyway', () => {
      expect(partialLoad([model('huge:bf16', usableGib * 1.2, usableGib * 0.5)], usable)).toBeNull();
    });

    it('finds a model that fits the GPU held entirely on the CPU', () => {
      expect(partialLoad([model('big:q8', usableGib * 0.6, 0)], usable)).toMatchObject({
        model: 'big:q8',
        gpuBytes: 0,
      });
    });
  });

  describe('partialLoad', () => {
    it('ignores sizes that are not finite', () => {
      const odd = (sizeBytes: number, vramBytes: number): LoadedModel => ({
        ...model('x', 1, 1),
        sizeBytes,
        vramBytes,
      });
      expect(partialLoad([odd(Number.NaN, GIB)], 64 * GIB)).toBeNull();
      expect(partialLoad([odd(10 * GIB, Number.NaN)], 64 * GIB)).toBeNull();
      expect(partialLoad([odd(Number.POSITIVE_INFINITY, GIB)], 64 * GIB)).toBeNull();
      expect(partialLoad([model('big:q8', 10, 5)], Number.NaN)).toBeNull();
    });
  });

  describe.each([24, 64, 96])('clearsCap after a %i GiB cap', capGib => {
    const capped = { model: 'big:q8', sizeBytes: capGib * 1.5 * GIB, gpuBytes: capGib * GIB };

    it('clears once a model as large as the capped one runs fully on the GPU', () => {
      expect(clearsCap([model('big:q8', capGib * 1.5, capGib * 1.5)], capped)).toBe(true);
      expect(clearsCap([model('other', capGib * 2, capGib * 2)], capped)).toBe(true);
    });

    it('clears for a load short of the GPU only by rounding, as partialLoad tolerates', () => {
      expect(clearsCap([model('big:q8', capGib * 1.5, capGib * 1.5 * 0.95)], capped)).toBe(true);
    });

    it('keeps it for a model the capped Ollama could hold anyway, or one still short', () => {
      expect(clearsCap([model('small', capGib * 0.5, capGib * 0.5)], capped)).toBe(false);
      expect(clearsCap([model('other', capGib + 1, capGib + 1)], capped)).toBe(false);
      expect(clearsCap([model('big:q8', capGib * 1.5, capGib)], capped)).toBe(false);
      expect(clearsCap([], capped)).toBe(false);
    });
  });
});

describe('ollamaWslPatch', () => {
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
      [
        'the listener is on the IPv6 loopback and the address is IPv4',
        [{ ...ON_V6_LOOPBACK, inode: 5001 }],
        OLLAMA_URL,
      ],
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

    it('finds none when two servers each hold every socket the address reaches', async () => {
      await writeSockets([LISTENING, ON_V6_LOOPBACK]);
      await writeServer({ pid: 100, image: stockImage(), sockets: [5001, 5002] });
      await writeServer({ pid: 300, image: imageWith(SHARED), sockets: [5001, 5002] });
      expect(await servingOllamaPid(LOCALHOST_URL, root)).toBeNull();
    });

    it('finds none when a server holds only some of the sockets the address reaches', async () => {
      await writeSockets([LISTENING, ON_V6_LOOPBACK]);
      await writeServer({ pid: 100, image: stockImage(), sockets: [5001] });
      expect(await servingOllamaPid(LOCALHOST_URL, root)).toBeNull();
    });

    it.each([
      [
        'another program, such as a port proxy',
        { comm: 'docker-proxy', argv: ['docker-proxy', '-host-port', '11434'] },
      ],
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
      ['f', false],
      ['F', false],
      ['FALSE', false],
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

    it('lets OLLAMA_WSL_SHARED_GPU_MEMORY=0 decide in a build with both settings', async () => {
      await serving({ image: imageWith(`${SPILL}${SHARED}`), environ: { [SHARED]: '0' } });
      expect(await createOllamaWslPatchProbe({ root })(OLLAMA_URL)).toMatchObject({ patched: false });
    });

    it('is unknown when the server binary cannot be examined', async () => {
      await serving({ image: imageWith(SHARED) });
      await rm(join(root, 'proc', '100', 'exe'));
      expect(await createOllamaWslPatchProbe({ root })(OLLAMA_URL)).toBeNull();
    });

    it('is unknown when the server start time cannot be read', async () => {
      await serving({ image: imageWith(SHARED) });
      await rm(join(root, 'proc', '100', 'stat'));
      expect(await createOllamaWslPatchProbe({ root })(OLLAMA_URL)).toBeNull();
    });

    it('reads again when the cached server can no longer be examined', async () => {
      await serving({ image: imageWith(SHARED) });
      const serverPid = vi.fn((url: string) => servingOllamaPid(url, root));
      const probe = createOllamaWslPatchProbe({ root, serverPid });
      expect(await probe(OLLAMA_URL)).toMatchObject({ patched: true });
      await rm(join(root, 'proc', '100', 'stat'));
      expect(await probe(OLLAMA_URL)).toBeNull();
      expect(serverPid).toHaveBeenCalledTimes(2);
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

    it.each([false, true])('backs off a timed-out binary read; restart=%s bypasses the backoff', async restart => {
      await serving({ image: imageWith(SHARED) });
      vi.useFakeTimers();
      try {
        let signalOpened: () => void = () => {};
        const opened = new Promise<void>(resolve => (signalOpened = resolve));
        const openFile = vi
          .fn<typeof open>()
          .mockImplementation(open)
          .mockImplementationOnce(() => {
            signalOpened();
            return new Promise(() => {});
          });
        const probe = createOllamaWslPatchProbe({ root, timeoutMs: 100, openFile });
        const first = probe(OLLAMA_URL);
        await opened;
        await vi.advanceTimersByTimeAsync(100);
        expect(await first).toBeNull();
        expect(await probe(OLLAMA_URL)).toMatchObject({ patched: null });
        expect(openFile).toHaveBeenCalledTimes(1);
        if (restart) {
          await writeServer({ pid: 100, sockets: [5001], image: imageWith(SHARED), started: 9000 });
        } else {
          await vi.advanceTimersByTimeAsync(30_000);
        }
        expect(await probe(OLLAMA_URL)).toMatchObject({ patched: true });
        expect(openFile).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
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
});

describe('loadedState', () => {
  const entry = (name: string, expiresAt: string | null = null) => ({
    name,
    sizeBytes: 1,
    vramBytes: 1,
    contextLength: null,
    expiresAt,
  });

  describe('loadedStateTarget', () => {
    it('maps the runtime id inside a local model id to a server', () => {
      expect(loadedStateTarget('local:ollama:qwen3:8b')).toEqual({ serverId: 'local', model: 'qwen3:8b' });
      expect(loadedStateTarget('local:srv-abc:hf.co/org/repo:Q4_K_M')).toEqual({
        serverId: 'abc',
        model: 'hf.co/org/repo:Q4_K_M',
      });
      expect(loadedStateTarget('local:other:qwen')).toBeNull();
      expect(loadedStateTarget('local:')).toBeNull();
      expect(loadedStateTarget('gpt-5')).toBeNull();
    });
  });

  describe('loadedStateOf', () => {
    it('treats a bare name and its :latest tag as the same model', () => {
      expect(loadedStateOf([entry('llama3:latest')], 'llama3')).toEqual({ kind: 'loaded', expiresAt: null });
      expect(loadedStateOf([entry('llama3')], 'llama3:latest')).toEqual({ kind: 'loaded', expiresAt: null });
      expect(loadedStateOf([entry('llama3:70b')], 'llama3')).toEqual({ kind: 'unloaded' });
    });

    it('does not read a registry port as a tag', () => {
      expect(loadedStateOf([entry('host:5000/team/model:latest')], 'host:5000/team/model')).toMatchObject({
        kind: 'loaded',
      });
    });

    it('parses the keep-alive expiry, and drops one it cannot read', () => {
      expect(loadedStateOf([entry('qwen3:8b', '2026-11-02T12:05:00.123Z')], 'qwen3:8b')).toEqual({
        kind: 'loaded',
        expiresAt: Date.parse('2026-11-02T12:05:00.123Z'),
      });
      expect(loadedStateOf([entry('qwen3:8b', 'soon')], 'qwen3:8b')).toEqual({ kind: 'loaded', expiresAt: null });
    });

    it('keeps the context it is loaded with when the server says', () => {
      expect(loadedStateOf([{ ...entry('qwen3:8b'), contextLength: 65536 }], 'qwen3:8b')).toEqual({
        kind: 'loaded',
        expiresAt: null,
        contextLength: 65536,
      });
    });

    it('is unloaded when nothing matching is in memory', () => {
      expect(loadedStateOf([], 'qwen3:8b')).toEqual({ kind: 'unloaded' });
    });
  });
});

describe('projectorBytes', () => {
  const digest = (n: number) => String(n).repeat(64);
  const here = { onThisComputer: true };

  describe('installedProjectorBytes', () => {
    let storeDir: string;
    beforeEach(async () => {
      storeDir = await mkdtemp(join(tmpdir(), 'b4m-store-'));
      await mkdir(join(storeDir, 'blobs'));
      for (const [n, size] of [
        [1, 1000],
        [2, 2500],
      ]) {
        const blob = join(storeDir, 'blobs', `sha256-${digest(n)}`);
        await writeFile(blob, '');
        await truncate(blob, size);
      }
    });
    afterEach(() => rm(storeDir, { recursive: true, force: true }));

    it("reads this computer's projector blobs from the model folder", async () => {
      expect(await installedProjectorBytes({ projectorBlobs: [digest(1), digest(2)], storeDir }, here)).toBe(3500);
      expect(await installedProjectorBytes({ projectorBlobs: [], storeDir }, here)).toBe(0);
    });

    it('counts none unless every projector size is known', async () => {
      expect(await installedProjectorBytes({ projectorBlobs: [digest(1), digest(3)], storeDir }, here)).toBe(0);
      expect(await installedProjectorBytes({ projectorBlobs: [digest(1), null], storeDir }, here)).toBe(0);
      expect(await installedProjectorBytes({ projectorBlobs: [digest(1)], storeDir: null }, here)).toBe(0);
      expect(await installedProjectorBytes(undefined, here)).toBe(0);
    });

    it("looks a saved server's projectors up in the pins and never reads this computer's disk for them", async () => {
      const server = { pinned: new Map([[digest(3), 4000]]), onThisComputer: false };
      expect(await installedProjectorBytes({ projectorBlobs: [digest(3)], storeDir }, server)).toBe(4000);
      expect(await installedProjectorBytes({ projectorBlobs: [digest(1)], storeDir }, server)).toBe(0);
    });

    it("falls back to the pins for a projector blob this computer's folder does not hold", async () => {
      const pinned = new Map([
        [digest(3), 4000],
        [digest(1), 9999],
      ]);
      expect(
        await installedProjectorBytes({ projectorBlobs: [digest(1), digest(3)], storeDir }, { ...here, pinned })
      ).toBe(5000);
      expect(await installedProjectorBytes({ projectorBlobs: [digest(3)], storeDir: null }, { ...here, pinned })).toBe(
        4000
      );
    });

    it('reads a projector once per digest and again after forget or a new digest', async () => {
      const projectorBytes = vi.fn(async () => 2500);
      const sizing = localContextSizing({
        setting: async () => AUTO_LOCAL_CONTEXT,
        hardware: new HardwareProbe(async () => unifiedMachine(16)),
        projectorBytes,
      });
      const facts = { name: 'vision', modelfile: 'FROM x', sizeBytes: 5e9, digest: 'one' };
      expect((await sizing.footprint(facts)).projectorBytes).toBe(2500);
      expect((await sizing.footprint(facts)).projectorBytes).toBe(2500);
      expect(projectorBytes).toHaveBeenCalledTimes(1);
      await sizing.footprint({ ...facts, digest: 'two' });
      expect(projectorBytes).toHaveBeenCalledTimes(2);
      sizing.forget?.();
      await sizing.footprint({ ...facts, digest: 'two' });
      expect(projectorBytes).toHaveBeenCalledTimes(3);
      expect((await sizing.footprint({ ...facts, modelfile: undefined, digest: 'three' })).projectorBytes).toBe(0);
      expect(projectorBytes).toHaveBeenCalledTimes(3);
    });

    it("sizes chat's projector from the Modelfile Ollama shows", async () => {
      const modelfile = `FROM ${join(storeDir, 'blobs', `sha256-${digest(9)}`)}\nFROM ${join(storeDir, 'blobs', `sha256-${digest(2)}`)}\n`;
      const sizing = localContextSizing({
        setting: async () => AUTO_LOCAL_CONTEXT,
        hardware: new HardwareProbe(async () => unifiedMachine(16)),
      });
      const footprint = await sizing.footprint({ name: 'vision', modelfile, sizeBytes: 5e9, digest: 'one' });
      expect(footprint.projectorBytes).toBe(2500);
      expect(sizing.cachedFootprint({ name: 'vision', modelfile, sizeBytes: 5e9, digest: 'one' }).projectorBytes).toBe(
        2500
      );
    });
  });

  describe('pinnedProjectorSizes', () => {
    it('maps every pinned projector in the bundled list to its size', () => {
      const sizes = pinnedProjectorSizes(loadPackageCuratedManifest(() => {}));
      // Gemma 4 12B's library projector, read from the blob Ollama stores under that digest.
      expect(sizes.get('e70b0e5cd80323d5d588b4ed06780356b7b1ba03995a4b8164c6ae9db0ff5989')).toBe(175_115_264);
      expect(sizes.get('13cb7bebccbd04afc8f4090cb949ecf8937cdf7377c5799b1a0c594e7c0d3e16')).toBe(931_146_528);
    });
  });
});

describe('pullLedger', () => {
  const directories: string[] = [];

  afterEach(async () =>
    Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
  );

  const STARTED: StartedPull = {
    key: 'qwen/qwen3-0.6b-gguf#qwen3-0.6b-q8_0',
    serverId: 'local',
    serverName: 'This computer',
    ref: 'hf.co/Qwen/Qwen3-0.6B-GGUF:Q8_0',
    label: 'Q8_0',
    sizeBytes: 639_446_688,
  };

  function pull(phase: ModelPull['phase'], key = STARTED.key): ModelPull {
    return {
      key,
      serverId: 'local',
      serverName: 'This computer',
      repo: 'Qwen/Qwen3-0.6B-GGUF',
      buildId: 'qwen3-0.6b-q8_0',
      label: 'Q8_0',
      ref: STARTED.ref,
      phase,
      completedBytes: 0,
      totalBytes: null,
      expectedBytes: STARTED.sizeBytes,
      error: null,
    };
  }

  async function setup(initial: ModelPull[] = [pull('downloading')]) {
    const directory = await mkdtemp(join(tmpdir(), 'b4m-pull-ledger-'));
    directories.push(directory);
    const path = join(directory, 'capability-ledger.json');
    let pulls = initial;
    const warn = vi.fn();
    const ledger = new CapabilityLedger(path);
    const recorder = new PullLedger(ledger, () => pulls, warn);
    return { ledger, recorder, warn, path, setPulls: (next: ModelPull[]) => (pulls = next) };
  }

  describe('PullLedger', () => {
    it('records an approved download as a desktop grant and its use, with size, server and folder', async () => {
      const { ledger, recorder } = await setup();
      await recorder.started(STARTED, { path: '/home/me/.ollama/models', source: 'runtime', freeBytes: 1 });

      const { grants, audit } = await ledger.state();
      expect(grants).toHaveLength(1);
      expect(grants[0]).toMatchObject({
        subject: { kind: 'desktop-user' },
        capability: 'model-download',
        source: 'approval',
        scope: {
          kind: 'model-pull',
          value: STARTED.key,
          model: 'hf.co/Qwen/Qwen3-0.6B-GGUF:Q8_0',
          server: 'This computer',
          bytes: STARTED.sizeBytes,
          path: '/home/me/.ollama/models',
          pathSource: 'runtime',
        },
      });
      expect(grants[0].revokedAt).toBeUndefined();
      expect(audit.map(event => event.type)).toEqual(['use', 'grant']);
    });

    it('records a guessed folder as a guess, and no folder when none is known', async () => {
      const guessed = await setup();
      await guessed.recorder.started(STARTED, {
        path: '/usr/share/ollama/.ollama/models',
        source: 'default',
        freeBytes: 1,
      });
      expect((await guessed.ledger.state()).grants[0].scope).toMatchObject({
        path: '/usr/share/ollama/.ollama/models',
        pathSource: 'default',
      });

      const unknown = await setup();
      await unknown.recorder.started(STARTED, { path: null, source: null, freeBytes: null });
      const scope = (await unknown.ledger.state()).grants[0].scope;
      expect(scope).not.toHaveProperty('path');
      expect(scope).not.toHaveProperty('pathSource');
    });

    it('retries a revoke that failed when the downloads next change', async () => {
      const { ledger, recorder, warn } = await setup();
      await recorder.started(STARTED, null);
      await recorder.settled([pull('downloading')]);
      const revoke = vi.spyOn(ledger, 'revokeMatching').mockRejectedValueOnce(new Error('disk full'));
      await recorder.settled([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('disk full'));
      expect((await ledger.state()).grants[0].revokedAt).toBeUndefined();

      await recorder.settled([]);
      expect(revoke).toHaveBeenCalledTimes(2);
      expect((await ledger.state()).grants[0].revokedAt).toBeDefined();
    });

    it('keeps the grant while the download runs or pauses, and revokes it once it finishes or fails', async () => {
      const { ledger, recorder } = await setup();
      await recorder.started(STARTED, null);
      await recorder.settled([pull('downloading')]);
      await recorder.settled([pull('paused')]);
      expect((await ledger.state()).grants[0].revokedAt).toBeUndefined();

      await recorder.settled([pull('failed')]);
      const { grants, audit } = await ledger.state();
      expect(grants[0].revokedAt).toBeDefined();
      expect(audit[0]).toMatchObject({ type: 'revoke', grantId: grants[0].id });
    });

    it('revokes the grant of a download that ended while an earlier revoke was still being written', async () => {
      const { ledger, recorder } = await setup();
      await recorder.started(STARTED, null);
      const first = recorder.settled([pull('downloading')]);
      const second = recorder.settled([]);
      await Promise.all([first, second]);
      expect((await ledger.state()).grants[0].revokedAt).toBeDefined();
    });

    it('revokes a grant written after its download already ended', async () => {
      const { ledger, recorder, setPulls } = await setup();
      setPulls([]);
      await recorder.started(STARTED, null);
      expect((await ledger.state()).grants[0].revokedAt).toBeDefined();
    });

    it('closes download grants left open by a previous run', async () => {
      const first = await setup();
      await first.recorder.started(STARTED, null);
      const again = new PullLedger(new CapabilityLedger(first.path), () => [], vi.fn());
      await again.retireAll();
      expect((await new CapabilityLedger(first.path).state()).grants[0].revokedAt).toBeDefined();
    });

    it('never fails a download over a ledger it cannot write', async () => {
      const { ledger, recorder, warn } = await setup();
      vi.spyOn(ledger, 'grant').mockRejectedValue(new Error('disk full'));
      await expect(recorder.started(STARTED, null)).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('disk full'));
    });
  });
});

describe('enteredHardware', () => {
  const GIB = 1024 ** 3;

  const probe = (overrides: Partial<HardwareProfile> = {}): HardwareProfile => ({
    platform: 'linux',
    arch: 'x64',
    memoryKind: 'cpu',
    totalMemoryBytes: 62 * GIB,
    gpuMemoryBytes: null,
    gpuName: null,
    gpuCount: 0,
    gpuVendor: null,
    chip: null,
    diskFreeBytes: 100 * GIB,
    confidence: 'low',
    ...overrides,
  });

  const specs = (overrides: Partial<ModelServerSpecs> = {}): ModelServerSpecs => ({
    ramGiB: null,
    gpuMemoryGiB: null,
    bandwidthGBps: null,
    unified: false,
    ...overrides,
  });

  describe('withEnteredSpecs', () => {
    it('returns the probe untouched without entered figures', () => {
      const probed = probe();
      expect(withEnteredSpecs(probed, null)).toBe(probed);
      expect(withEnteredSpecs(probed, specs())).toBe(probed);
    });

    it('adds entered bandwidth in bytes per second, with or without entered memory', () => {
      const probed = probe();
      expect(withEnteredSpecs(probed, specs({ bandwidthGBps: 256 }))).toEqual({
        ...probed,
        memoryBandwidthBytesPerSec: 256e9,
      });
      expect(withEnteredSpecs(probed, specs({ ramGiB: 64, bandwidthGBps: 256 }))).toMatchObject({
        totalMemoryBytes: 64 * GIB,
        memoryBandwidthBytesPerSec: 256e9,
      });
    });

    it('replaces RAM alone and keeps what the probe knew about the GPU', () => {
      const probed = probe({
        memoryKind: 'discrete',
        gpuMemoryBytes: 24 * GIB,
        gpuName: 'Test GPU',
        gpuCount: 1,
        gpuVendor: 'nvidia',
        confidence: 'high',
      });
      expect(withEnteredSpecs(probed, specs({ ramGiB: 128 }))).toEqual({ ...probed, totalMemoryBytes: 128 * GIB });
    });

    it('makes a probe that found no GPU a discrete GPU of unknown vendor once GPU memory is entered', () => {
      const next = withEnteredSpecs(probe(), specs({ gpuMemoryGiB: 16 }));
      expect(next).toMatchObject({ memoryKind: 'discrete', gpuMemoryBytes: 16 * GIB, gpuCount: 1, confidence: 'high' });
      expect('gpuVendor' in next).toBe(false);
    });

    it('keeps unified memory unified and takes the entered GPU memory as what its GPU can use', () => {
      const probed = probe({ memoryKind: 'unified', gpuVendor: 'amd', gpuCount: 0, gpuName: 'Radeon' });
      expect(withEnteredSpecs(probed, specs({ ramGiB: 128, gpuMemoryGiB: 96 }))).toMatchObject({
        memoryKind: 'unified',
        totalMemoryBytes: 128 * GIB,
        gpuMemoryBytes: 96 * GIB,
        gpuVendor: 'amd',
        confidence: 'high',
      });
    });
  });

  describe('serverHardware', () => {
    it('leaves a server without RAM unrated', () => {
      expect(serverHardware(null)).toBeNull();
      expect(serverHardware(specs({ gpuMemoryGiB: 24 }))).toBeNull();
    });

    it.each([
      ['RAM only', specs({ ramGiB: 64 }), { memoryKind: 'cpu', gpuMemoryBytes: null, gpuCount: 0 }],
      [
        'a discrete GPU',
        specs({ ramGiB: 64, gpuMemoryGiB: 24 }),
        { memoryKind: 'discrete', gpuMemoryBytes: 24 * GIB, gpuCount: 1 },
      ],
      ['unified memory', specs({ ramGiB: 64, unified: true }), { memoryKind: 'unified', gpuMemoryBytes: null }],
      [
        'unified memory with a GPU budget',
        specs({ ramGiB: 128, gpuMemoryGiB: 96, unified: true }),
        { memoryKind: 'unified', gpuMemoryBytes: 96 * GIB, gpuCount: 0 },
      ],
    ] as const)('describes %s', (_label, entered, expected) => {
      expect(serverHardware(entered)).toMatchObject({ ...expected, confidence: 'high' });
    });

    it('carries entered bandwidth in bytes per second', () => {
      expect(serverHardware(specs({ ramGiB: 64 }))?.memoryBandwidthBytesPerSec).toBeNull();
      expect(serverHardware(specs({ ramGiB: 64, bandwidthGBps: 1008 }))?.memoryBandwidthBytesPerSec).toBe(1008e9);
    });
  });
});

describe('catalogSampling', () => {
  const manifest = loadCuratedManifest(() => undefined);

  describe('catalogSampling', () => {
    it('gives every reviewed build a seed under each name Ollama lists it by', () => {
      const builds = curatedListing(manifest).flatMap(({ entry, builds }) => builds.map(build => ({ entry, build })));
      expect(builds.length).toBeGreaterThan(0);
      for (const { entry, build } of builds) {
        const family = manifest.families[entry.family];
        for (const name of ollamaRefAliases(curatedSource(build).ollamaRef)) {
          const seed = catalogSampling(manifest, name);
          expect(seed, name).toBeDefined();
          expect(seed?.thinking?.temperature, name).toBe(family?.sampling.thinking?.temperature);
          expect(seed?.nonThinking?.temperature, name).toBe(family?.sampling.nonThinking?.temperature);
        }
      }
    });

    it('seeds every curated library build as local Ollama reports it: weights blob plus its params layer', () => {
      const libraryBuilds = curatedListing(manifest)
        .flatMap(({ entry, builds }) => builds.map(build => ({ entry, library: curatedLibrary(build) })))
        .flatMap(({ entry, library }) => (library ? [{ entry, library }] : []));
      expect(libraryBuilds.length).toBeGreaterThan(0);
      const layers: Record<string, { params: Record<string, number> | null }> = paramsLayers;
      for (const { entry, library } of libraryBuilds) {
        const layer = layers[library.ref];
        expect(layer, library.ref).toBeDefined();
        const parameters = Object.entries(layer?.params ?? {})
          .map(([key, value]) => `${key.padEnd(20)}${value}`)
          .join('\n');
        const seed = catalogSampling(manifest, 'my-copy:latest', library.digest, parameters);
        expect(seed, library.ref).toBeDefined();
        expect(seed?.thinking?.temperature, library.ref).toBe(
          manifest.families[entry.family]?.sampling.thinking?.temperature
        );
      }
    });

    it("maps a family's sampling to generation fields, including the pinned repeat penalty", () => {
      expect(catalogSampling(manifest, 'qwen3.5:4b')).toEqual({
        thinking: { temperature: 1, topP: 0.95, topK: 20, minP: 0, presencePenalty: 1.5, repeatPenalty: 1 },
        nonThinking: { temperature: 0.7, topP: 0.8, topK: 20, minP: 0, presencePenalty: 1.5, repeatPenalty: 1 },
      });
      expect(catalogSampling(manifest, 'qwen3.5:0.8b')).toEqual({
        thinking: { temperature: 1, topP: 0.95, topK: 20, minP: 0, presencePenalty: 1.5, repeatPenalty: 1 },
        nonThinking: { temperature: 1, topP: 1, topK: 20, minP: 0, presencePenalty: 2, repeatPenalty: 1 },
      });
      expect(catalogSampling(manifest, 'qwen3.8:27b')).toEqual({
        thinking: { temperature: 1, topP: 0.95, topK: 20, minP: 0, presencePenalty: 0, repeatPenalty: 1 },
        nonThinking: { temperature: 0.7, topP: 0.8, topK: 20, minP: 0, presencePenalty: 1.5, repeatPenalty: 1 },
      });
      expect(catalogSampling(manifest, 'gemma4:12b-it-qat')).toMatchObject({
        thinking: { temperature: 1, topP: 0.95, topK: 64 },
        nonThinking: { temperature: 1, topP: 0.95, topK: 64 },
      });
    });

    it('matches an hf.co build by its pull ref, in any case', () => {
      expect(catalogSampling(manifest, 'hf.co/ista-daslab/qwen3.8-27b-gsq-rco-gguf:iq3_s')?.thinking).toMatchObject({
        temperature: 1,
        topK: 20,
      });
    });

    it('matches a copy under another name by its weights blob, and a llama-server model by its GGUF file name', () => {
      const qwen = manifest.entries.find(entry => entry.id === 'qwen3-5-4b')?.builds[0];
      const gsq = manifest.entries.find(entry => entry.id === 'qwen3-8-27b-gsq')?.builds[0];
      const blob = qwen?.ollama?.kind === 'library' ? qwen.ollama.digest : undefined;
      expect(blob).toBeDefined();
      expect(catalogSampling(manifest, 'my-qwen:latest', blob)).toEqual(catalogSampling(manifest, 'qwen3.5:4b'));
      expect(catalogSampling(manifest, 'gsq:latest', gsq?.weights[0].sha256)?.thinking).toMatchObject({ topK: 20 });
      expect(catalogSampling(manifest, `/models/${gsq?.weights[0].path}`)?.thinking).toMatchObject({ topK: 20 });
    });

    it("keeps the PARAMETER sampling of a model found by weights or file name, and a copy that sets the family's own", () => {
      const qwen = manifest.entries.find(entry => entry.id === 'qwen3-5-4b')?.builds[0];
      const gsq = manifest.entries.find(entry => entry.id === 'qwen3-8-27b-gsq')?.builds[0];
      const blob = qwen?.ollama?.kind === 'library' ? qwen.ollama.digest : undefined;
      const library = ['temperature 1', 'top_k 20', 'top_p 0.95', 'presence_penalty 1.5'].join('\n');
      const seeded = catalogSampling(manifest, 'qwen3.5:4b');
      expect(seeded).toBeDefined();
      expect(catalogSampling(manifest, 'my-variant:latest', blob, 'temperature 0.3')).toBeUndefined();
      expect(catalogSampling(manifest, 'my-variant:latest', blob, 'temperature 1\ntop_k 40')).toBeUndefined();
      expect(catalogSampling(manifest, 'my-copy:latest', blob, library)).toEqual(seeded);
      expect(catalogSampling(manifest, 'my-copy:latest', blob, 'num_ctx 8192')).toEqual(seeded);
      expect(catalogSampling(manifest, 'qwen3.5:4b', undefined, library)).toEqual(seeded);
      expect(
        catalogSampling(manifest, `/models/${gsq?.weights[0].path}`, undefined, 'temperature 0.3')
      ).toBeUndefined();
    });

    it('keeps the PARAMETER sampling of a model listed under a curated ref', () => {
      expect(catalogSampling(manifest, 'qwen3.5:4b', undefined, 'temperature 0.3')).toBeUndefined();
    });

    it('seeds a curated pull ref by family even when its weights differ from the pin', () => {
      expect(catalogSampling(manifest, 'qwen3.5:4b', 'f'.repeat(64))).toEqual(catalogSampling(manifest, 'qwen3.5:4b'));
      expect(catalogSampling(manifest, 'qwen3.5:4b', 'f'.repeat(64), 'temperature 0.3')).toBeUndefined();
    });

    it('gives a model with an adapter no seed, even when named exactly like a curated ref', () => {
      const blob = manifest.entries.find(entry => entry.id === 'qwen3-5-4b')?.builds[0].ollama;
      const digest = blob?.kind === 'library' ? blob.digest : undefined;
      expect(catalogSampling(manifest, 'qwen3.5:4b', undefined, undefined, true)).toBeUndefined();
      expect(catalogSampling(manifest, 'qwen3.5:4b', digest, undefined, true)).toBeUndefined();
    });

    it('pins every params layer fixture entry to the manifest by the sha256 of its compact JSON and a newline', () => {
      const fixture: Record<string, { params: Record<string, number> | null }> = paramsLayers;
      const builds = curatedListing(manifest).flatMap(({ builds }) => builds);
      for (const [ref, { params }] of Object.entries(fixture)) {
        const build = builds.find(candidate => curatedSource(candidate).ollamaRef === ref);
        expect(build, ref).toBeDefined();
        const digest = createHash('sha256')
          .update(`${JSON.stringify(params)}\n`)
          .digest('hex');
        expect(digest, ref).toBe(build && curatedPins(build)?.params);
      }
    });

    it('gives no seed to a model that is not a reviewed build', () => {
      expect(catalogSampling(manifest, 'llama3.2:latest')).toBeUndefined();
      expect(catalogSampling(manifest, 'qwen3.8:27b-unreviewed-tag')).toBeUndefined();
      expect(catalogSampling(manifest, 'my-qwen:latest', 'f'.repeat(64))).toBeUndefined();
      expect(catalogSampling(manifest, '/models/Llama-3.2-3B-Q4_K_M.gguf')).toBeUndefined();
    });
  });
});

describe('loadCuratedManifest', () => {
  describe('olderThan', () => {
    it.each([
      ['0.1.11', '0.1.12', true],
      ['0.1.12', '0.1.12', false],
      ['0.1.13', '0.1.12', false],
      ['0.2.0', '0.1.12', false],
      ['1.0.0', '0.9.9', false],
      ['0.1.12-beta.1', '0.1.12', false],
      ['0.1.11-beta.1', '0.1.12', true],
      ['0.203.0-dev.gabc123def456.dirty', '0.203.0', false],
      ['0.203.0-dev.gabc123def456', '0.203.1', true],
      ['0.0.0-dev.unknown', '0.1.0', true],
      ['invalid', '0.1.12', false],
      ['', '0.1.12', false],
      ['0.1.12', 'invalid', false],
    ])('compares %s to %s by major.minor.patch', (version, minimum, expected) => {
      expect(olderThan(version, minimum)).toBe(expected);
    });
  });

  describe('loadCuratedManifest Desktop compatibility', () => {
    const fixture = () => {
      const list = JSON.parse(BUNDLED_CURATED_TEXT) as {
        entries: { id: string; minDesktopVersion?: string }[];
      };
      list.entries[0].minDesktopVersion = '0.2.0';
      return list;
    };

    it.each([
      ['0.1.12', false],
      ['0.2.0', true],
      ['0.2.1', true],
      ['0.2.0-beta.1', true],
      ['invalid', true],
      [undefined, true],
    ])('filters only entries newer than Desktop %s', (desktopVersion, keep) => {
      const input = fixture();
      const warn = vi.fn();
      const manifest = loadCuratedManifest(warn, input, { desktopVersion });
      expect(manifest.entries.some(entry => entry.id === input.entries[0].id)).toBe(keep);
      expect(manifest.entries.map(entry => entry.id)).toEqual(input.entries.slice(keep ? 0 : 1).map(entry => entry.id));
      if (keep) expect(warn).not.toHaveBeenCalled();
      else expect(warn).toHaveBeenCalledWith(expect.stringContaining('needs Desktop 0.2.0 or newer'));
    });

    it('falls back to the bundled list when the envelope is unreadable', () => {
      const warn = vi.fn();
      const desktopVersion = '0.1.12';
      const expected = loadCuratedManifest(() => {}, undefined, { desktopVersion });
      expect(loadCuratedManifest(warn, { schemaVersion: 3 }, { desktopVersion })).toEqual(expected);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('showing the bundled one'));
    });
  });
});

describe('curated dev key', () => {
  describe('the curated test keys', () => {
    // Pinned so the copy in packages/scripts/src/curatedCatalog/devKey.ts can be checked against the same ids.
    it('derives the documented key ids from the public seeds', () => {
      expect(curatedDevKey()).toEqual({
        keyId: 'b132926cb06522d5',
        spki: 'MCowBQYDK2VwAyEAMC/oy7zJ6C0JTNO6iNeUkZH5dt0BcgCO10LLD03Dd7k=',
        role: 'signing',
      });
      expect(curatedDevKey('recovery')).toEqual({
        keyId: '689f488b0fe321ad',
        spki: 'MCowBQYDK2VwAyEAoSzeSXfg787PWFohPkJRKanpfh/Wh2K3MlnQp3OobBM=',
        role: 'recovery',
      });
    });

    it('is never in the production keyring', () => {
      for (const dev of [curatedDevKey('signing'), curatedDevKey('recovery')])
        expect(PRODUCTION_CURATED_KEYS.some(key => key.keyId === dev.keyId || key.spki === dev.spki)).toBe(false);
    });

    it('is never offered to a packaged app', () => {
      expect(curatedDevOverrides(true, { B4M_CURATED_DEV_URL: 'http://127.0.0.1:4321/latest.json' })).toBeNull();
    });

    it('takes the URL override from the environment of an unpackaged run', () => {
      expect(curatedDevOverrides(false, { B4M_CURATED_DEV_URL: ' http://127.0.0.1:4321/latest.json ' })).toEqual({
        keys: [curatedDevKey('signing'), curatedDevKey('recovery')],
        url: 'http://127.0.0.1:4321/latest.json',
      });
      expect(curatedDevOverrides(false, {})?.url).toBeNull();
    });
  });
});

describe('HuggingFaceTokenStore', () => {
  const TOKEN = 'hf_TestTokenThatMustNeverLeak0123456789';

  function cipher(available = true) {
    return {
      isEncryptionAvailable: vi.fn(() => available),
      encryptString: vi.fn((plain: string) => Buffer.from(`enc:${Buffer.from(plain).toString('hex')}`)),
      decryptString: vi.fn((encrypted: Buffer) => {
        const text = encrypted.toString();
        if (!text.startsWith('enc:')) throw new Error('bad blob');
        return Buffer.from(text.slice(4), 'hex').toString();
      }),
    };
  }

  function disk(initial: string | null = null) {
    const file = { contents: initial, read: vi.fn(async () => file.contents), write: vi.fn() };
    file.write.mockImplementation(async (next: string) => {
      file.contents = next;
    });
    return file;
  }

  const logger = () => ({ debug: vi.fn(), warn: vi.fn() });

  describe('HuggingFaceTokenStore', () => {
    it('keeps the token when removing it fails to write', async () => {
      const file = disk();
      const store = new HuggingFaceTokenStore(cipher(), file, logger());
      await store.set(TOKEN);
      file.write.mockRejectedValueOnce(new Error('EACCES'));
      await expect(store.clear()).rejects.toThrow('EACCES');
      expect(await store.get()).toBe(TOKEN);
      expect(await new HuggingFaceTokenStore(cipher(), file, logger()).get()).toBe(TOKEN);
    });

    it('keeps the token encrypted on disk and reads it back in a new run', async () => {
      const file = disk();
      await new HuggingFaceTokenStore(cipher(), file, logger()).set(TOKEN);
      expect(file.contents).not.toContain(TOKEN);
      expect(JSON.parse(file.contents ?? '{}')).toMatchObject({ version: 1, token: expect.any(String) });

      const next = new HuggingFaceTokenStore(cipher(), file, logger());
      expect(await next.get()).toBe(TOKEN);
      expect(next.persisted()).toBe(true);
    });

    it('without a keychain keeps the token for this run only and writes none of it', async () => {
      const file = disk();
      const store = new HuggingFaceTokenStore(cipher(false), file, logger());
      await store.set(TOKEN);
      expect(await store.get()).toBe(TOKEN);
      expect(store.persisted()).toBe(false);
      expect(file.contents).toBe('{"version":1}');

      expect(await new HuggingFaceTokenStore(cipher(false), file, logger()).get()).toBeNull();
    });

    it('removes the token from memory and disk', async () => {
      const file = disk();
      const store = new HuggingFaceTokenStore(cipher(), file, logger());
      await store.set(TOKEN);
      await store.clear();
      expect(await store.get()).toBeNull();
      expect(file.contents).toBe('{"version":1}');
      expect(await new HuggingFaceTokenStore(cipher(), file, logger()).get()).toBeNull();
    });

    it('drops a blob it cannot decrypt without logging the blob', async () => {
      const file = disk(JSON.stringify({ version: 1, token: Buffer.from(TOKEN).toString('base64') }));
      const log = logger();
      expect(await new HuggingFaceTokenStore(cipher(), file, log).get()).toBeNull();
      expect(log.warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify([log.warn.mock.calls, log.debug.mock.calls])).not.toContain(TOKEN);
    });

    it('reports unreadable files and retries the read without logging credentials', async () => {
      const missing = disk();
      missing.read.mockRejectedValueOnce(new Error('EACCES'));
      const log = logger();
      const store = new HuggingFaceTokenStore(cipher(), missing, log);
      await expect(store.get()).rejects.toThrow('Could not read');
      expect(log.warn).toHaveBeenCalledOnce();
      expect(await store.get()).toBeNull();
      expect(missing.read).toHaveBeenCalledTimes(2);
      expect(await new HuggingFaceTokenStore(cipher(), disk('{not json'), logger()).get()).toBeNull();
    });

    it('never persists a token with the Linux basic_text backend', async () => {
      const encryption = { ...cipher(), getSelectedStorageBackend: () => 'basic_text' };
      const file = disk();
      const store = new HuggingFaceTokenStore(encryption, file, logger());
      await store.set(TOKEN);
      expect(store.persisted()).toBe(false);
      expect(encryption.encryptString).not.toHaveBeenCalled();
      expect(file.contents).toBe('{"version":1}');
      expect(await store.get()).toBe(TOKEN);
      expect(await new HuggingFaceTokenStore(encryption, file, logger()).get()).toBeNull();
    });

    it('keeps the previous token when saving a replacement fails', async () => {
      const file = disk();
      const store = new HuggingFaceTokenStore(cipher(), file, logger());
      await store.set(TOKEN);
      file.write.mockRejectedValueOnce(new Error('EACCES'));
      await expect(store.set('hf_replacement')).rejects.toThrow('EACCES');
      expect(await store.get()).toBe(TOKEN);
      expect(await new HuggingFaceTokenStore(cipher(), file, logger()).get()).toBe(TOKEN);
    });

    it('does not activate a token when encryption fails', async () => {
      const encryption = cipher();
      encryption.encryptString.mockImplementationOnce(() => {
        throw new Error('locked');
      });
      const store = new HuggingFaceTokenStore(encryption, disk(), logger());
      await expect(store.set(TOKEN)).rejects.toThrow('locked');
      expect(await store.get()).toBeNull();
    });
  });

  describe('HuggingFaceTokenStore.reencrypt', () => {
    const stored = (prefix: 'old' | 'new') => disk(JSON.stringify({ version: 1, token: sealedAs(prefix, TOKEN) }));
    const sealedToken = (file: { contents: string | null }) =>
      openedAs((JSON.parse(file.contents ?? '{}') as { token: string }).token);

    it('re-saves a legacy token once, and it still reads back', async () => {
      const file = stored('old');
      const store = new HuggingFaceTokenStore(versionedCipher('new'), file, logger());

      await store.reencrypt();
      await store.reencrypt();

      expect(sealedToken(file)).toBe(`new:${TOKEN}`);
      expect(file.write).toHaveBeenCalledTimes(1);
      expect(await new HuggingFaceTokenStore(versionedCipher('new'), file, logger()).get()).toBe(TOKEN);
    });

    it('leaves a current token alone', async () => {
      const file = stored('new');

      await new HuggingFaceTokenStore(versionedCipher('new'), file, logger()).reencrypt();

      expect(file.write).not.toHaveBeenCalled();
    });

    it('keeps a legacy token it cannot open, or has no keychain to re-save it to', async () => {
      for (const current of [
        versionedCipher('new', { opensOld: false }),
        versionedCipher('new', { available: false }),
      ]) {
        const file = stored('old');
        const before = file.contents;

        await new HuggingFaceTokenStore(current, file, logger()).reencrypt();

        expect(file.write).not.toHaveBeenCalled();
        expect(file.contents).toBe(before);
      }
    });

    it('does not even read the file with a cipher that asks for no migration', async () => {
      const file = stored('old');

      await new HuggingFaceTokenStore(cipher(), file, logger()).reencrypt();

      expect(file.read).not.toHaveBeenCalled();
      expect(file.write).not.toHaveBeenCalled();
    });
  });
});

describe('ipc', () => {
  type Handler = (event: unknown, ...args: unknown[]) => unknown;

  const CURATED = loadPackageCuratedManifest(() => {});

  function runtime(): ModelRuntimePort & { pull: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> } {
    return {
      baseUrl: 'http://192.168.1.20:11434',
      health: async () => ({ ok: true, version: '0.12.0', error: null }),
      list: async () => [],
      inspect: () => Promise.reject(new Error('not inspected here')),
      loaded: async () => [],
      pull: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    };
  }

  function setup(management: ModelServerManagement) {
    const local = runtime();
    const remote = runtime();
    const getModel = vi.fn(async (): Promise<HubModelDetail> => {
      throw new Error('the hub must not be asked for a refused pull');
    });
    const service = new ModelHubService({
      runtime: local,
      server: id => (id === 'gpu' ? { name: 'gpu box', management, runtime: remote } : null),
      createHub: () => ({
        endpoint: 'https://huggingface.co',
        search: async () => ({ models: [], nextCursor: null }),
        getModel,
        verifyOllamaRef: async () => null,
        ollamaLayers: async () => null,
        checkToken: async () => true,
      }),
      tokens: {
        persisted: () => true,
        get: async () => null,
        set: async () => undefined,
        clear: async () => undefined,
      },
      libraryLayers: async () => null,
      hardware: () => Promise.reject(new Error('not read here')),
      localContext: async () => AUTO_LOCAL_CONTEXT,
      curated: () => CURATED,
      onPullsChanged: () => undefined,
      onInstalledChanged: () => undefined,
      warn: () => undefined,
    });
    const handlers = new Map<string, Handler>();
    registerModelsIpc(
      {
        handle: (channel: string, listener: (...args: never[]) => unknown) =>
          void handlers.set(channel, listener as never),
      },
      service
    );
    const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)?.({}, ...args);
    return { invoke, local, remote, getModel };
  }

  const pullRequest = {
    repo: 'Qwen/Qwen2.5-0.5B-Instruct-GGUF',
    buildId: 'q4',
    revision: 'b'.repeat(40),
    sizeBytes: 1_000,
    acceptLicense: true,
    confirmAccess: true,
    serverId: 'gpu',
  };

  describe('registerModelsIpc', () => {
    it.each(['chat-only', 'unsupported'] as const)(
      'refuses a pull and a removal for a %s server before anything reaches it',
      async management => {
        const { invoke, local, remote, getModel } = setup(management);

        expect(await invoke(IPC_CHANNELS.modelsPull, pullRequest)).toMatchObject({
          ok: false,
          error: { kind: 'not-allowed', message: expect.stringContaining('gpu box') },
          listed: false,
        });
        expect(await invoke(IPC_CHANNELS.modelsRemove, 'qwen2.5:0.5b', 'gpu')).toMatchObject({
          ok: false,
          error: { kind: 'not-allowed' },
        });
        expect(getModel).not.toHaveBeenCalled();
        expect(remote.pull).not.toHaveBeenCalled();
        expect(remote.remove).not.toHaveBeenCalled();
        expect(local.remove).not.toHaveBeenCalled();
        expect(await invoke(IPC_CHANNELS.modelsListPulls)).toEqual([]);
      }
    );

    it('passes the server to a curated dialog, check and pull, so a Chat only server refuses each', async () => {
      const { invoke, remote, getModel } = setup('chat-only');
      const entry = CURATED.entries.find(candidate => candidate.id === 'gemma-4-e4b');
      const build = entry?.builds[0];
      if (!entry || !build) throw new Error('the bundled list lost its Gemma 4 E4B pick');
      const refused = { ok: false, error: { kind: 'not-allowed' } };
      expect(await invoke(IPC_CHANNELS.modelsGetCuratedPull, entry.id, build.id, 'gpu')).toMatchObject(refused);
      expect(await invoke(IPC_CHANNELS.modelsCheckCurated, entry.id, build.id, 'gpu')).toMatchObject(refused);
      expect(
        await invoke(IPC_CHANNELS.modelsPull, {
          ...pullRequest,
          repo: curatedLibrary(build)?.ref,
          buildId: build.id,
          curated: { entryId: entry.id, buildId: build.id },
        })
      ).toMatchObject({ ...refused, listed: false });
      expect(await invoke(IPC_CHANNELS.modelsGetCuratedPull, entry.id, build.id, 42)).toMatchObject({
        ok: false,
        error: { kind: 'invalid' },
      });
      expect(getModel).not.toHaveBeenCalled();
      expect(remote.pull).not.toHaveBeenCalled();
    });

    it('sends a removal to the named server, and to this computer without one', async () => {
      const { invoke, local, remote } = setup('allowed');
      expect(await invoke(IPC_CHANNELS.modelsRemove, 'qwen2.5:0.5b', 'gpu')).toEqual({ ok: true });
      expect(remote.remove).toHaveBeenCalledWith('qwen2.5:0.5b');
      expect(await invoke(IPC_CHANNELS.modelsRemove, 'llama3', undefined)).toEqual({ ok: true });
      expect(local.remove).toHaveBeenCalledWith('llama3');
    });

    it.each([42, null, '', { id: 'gpu' }])('refuses a server id of %j instead of acting on this computer', async id => {
      const { invoke, local, remote } = setup('allowed');
      expect(await invoke(IPC_CHANNELS.modelsRemove, 'llama3', id)).toMatchObject({
        ok: false,
        error: { kind: 'invalid' },
      });
      expect(await invoke(IPC_CHANNELS.modelsPull, { ...pullRequest, serverId: id })).toMatchObject({
        ok: false,
        error: { kind: 'invalid' },
        listed: false,
      });
      expect(await invoke(IPC_CHANNELS.modelsListInstalled, id)).toMatchObject({
        ok: false,
        error: { kind: 'invalid' },
      });
      expect(await invoke(IPC_CHANNELS.modelsGetStatus, id)).toMatchObject({ reachable: false, serverId: '' });
      expect(await invoke(IPC_CHANNELS.modelsGetStoreLocation, id)).toEqual({
        path: null,
        source: null,
        freeBytes: null,
      });
      expect(local.remove).not.toHaveBeenCalled();
      expect(remote.remove).not.toHaveBeenCalled();
    });

    it.each(['gpu/Qwen/Qwen2.5-0.5B-Instruct-GGUF', 'Qwen', 'Qwen/a#b', '../x/y'])(
      'refuses a pull of repo %s, so it cannot reuse another pull key',
      async repo => {
        const { invoke, getModel } = setup('allowed');
        expect(await invoke(IPC_CHANNELS.modelsPull, { ...pullRequest, repo, serverId: undefined })).toMatchObject({
          ok: false,
          error: { kind: 'invalid' },
        });
        expect(getModel).not.toHaveBeenCalled();
        expect(await invoke(IPC_CHANNELS.modelsListPulls)).toEqual([]);
      }
    );

    it('reports a server that is no longer saved', async () => {
      const { invoke } = setup('allowed');
      expect(await invoke(IPC_CHANNELS.modelsGetStatus, 'gone')).toMatchObject({ reachable: false, serverId: 'gone' });
      expect(await invoke(IPC_CHANNELS.modelsPull, { ...pullRequest, serverId: 'gone' })).toMatchObject({
        ok: false,
        error: { kind: 'not-found' },
      });
    });
  });

  describe('modelsGetLoadedState', () => {
    const loaded = (name: string, expiresAt: string | null) => ({
      name,
      sizeBytes: 1,
      vramBytes: 1,
      contextLength: null,
      expiresAt,
    });

    it("reads this computer's Ollama for an `ollama` runtime id and a saved server's for `srv-`", async () => {
      const { invoke, local, remote } = setup('chat-only');
      local.loaded = async () => [loaded('qwen3:8b', '2026-11-02T12:05:00Z')];
      remote.loaded = async () => [];

      expect(await invoke(IPC_CHANNELS.modelsGetLoadedState, 'local:ollama:qwen3:8b')).toEqual({
        kind: 'loaded',
        expiresAt: Date.parse('2026-11-02T12:05:00Z'),
      });
      expect(await invoke(IPC_CHANNELS.modelsGetLoadedState, 'local:srv-gpu:qwen3:8b')).toEqual({ kind: 'unloaded' });
    });

    it('answers unsupported for an OpenAI-compatible server, an unknown runtime and a malformed id', async () => {
      const { invoke, remote } = setup('unsupported');
      const ask = vi.fn(async () => []);
      remote.loaded = ask;

      for (const id of ['local:srv-gpu:qwen', 'local:srv-gone:qwen', 'local:other:qwen', 'claude-sonnet', 42]) {
        expect(await invoke(IPC_CHANNELS.modelsGetLoadedState, id)).toEqual({ kind: 'unsupported' });
      }
      expect(ask).not.toHaveBeenCalled();
    });

    it('answers unknown when the server cannot be asked', async () => {
      const { invoke, local } = setup('allowed');
      local.loaded = async () => {
        throw new Error('connection refused');
      };
      expect(await invoke(IPC_CHANNELS.modelsGetLoadedState, 'local:ollama:qwen3:8b')).toEqual({ kind: 'unknown' });
    });
  });
});
