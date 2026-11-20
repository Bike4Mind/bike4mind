import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, type networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { scanLinuxGpus } from './gpus';
import type { ExecLike } from './hardware';
import { parseCpuinfo, parseOsRelease, probeModelHost, type ModelHostProbeOptions } from './hostFacts';

vi.mock('./gpus', async importOriginal => {
  const actual = await importOriginal<typeof import('./gpus')>();
  return { ...actual, scanLinuxGpus: vi.fn(actual.scanLinuxGpus) };
});

const GiB = 1024 ** 3;

const CPUINFO = [0, 1, 2, 3]
  .map(
    processor =>
      `processor\t: ${processor}\nvendor_id\t: AuthenticAMD\nmodel name\t: AMD Ryzen 7 5800X 8-Core Processor\nphysical id\t: 0\ncore id\t\t: ${processor % 2}\n`
  )
  .join('\n');

const SHOW = [
  'MainPID=812',
  'ExecStart={ path=/usr/local/bin/ollama ; argv[]=/usr/local/bin/ollama serve ; ignore_errors=no }',
  'Environment=OLLAMA_NUM_PARALLEL=2 OLLAMA_FLASH_ATTENTION=1 OLLAMA_KV_CACHE_TYPE=q8_0',
  'User=ollama',
  'LoadState=loaded',
  'ActiveState=active',
  'FragmentPath=/etc/systemd/system/ollama.service',
  'DropInPaths=/etc/systemd/system/ollama.service.d/override.conf',
  '',
].join('\n');

const FILES = {
  'etc/os-release': 'NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 24.04.3 LTS"\n',
  'proc/sys/kernel/osrelease': '6.8.0-90-generic\n',
  'proc/cpuinfo': CPUINFO,
  'proc/meminfo': 'MemTotal:       65716204 kB\nMemAvailable:   50000000 kB\n',
  'proc/self/mountinfo': '22 1 259:2 / / rw,relatime shared:1 - ext4 /dev/nvme0n1p2 rw\n',
  'etc/passwd': 'root:x:0:0:root:/root:/bin/bash\nollama:x:998:998::/usr/share/ollama:/bin/false\n',
  'etc/systemd/system/ollama.service': '[Service]\nExecStart=/usr/local/bin/ollama serve\nUser=ollama\n',
  'etc/systemd/system/ollama.service.d/override.conf':
    '[Service]\nEnvironment="OLLAMA_NUM_PARALLEL=2"\nEnvironment="OLLAMA_FLASH_ATTENTION=1"\nEnvironment="OLLAMA_KV_CACHE_TYPE=q8_0"\n',
  'proc/812/comm': 'ollama\n',
  'proc/812/cmdline': '/usr/local/bin/ollama\0serve\0',
};

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'local-models-host-'));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const exec: ExecLike = async (command, args) => {
  if (command === 'systemctl' && args[0] !== '--user') return { stdout: SHOW };
  throw new Error(`${command} not found`);
};

function runtime(reachable = true) {
  return {
    health: vi.fn(async () =>
      reachable ? { ok: true, version: '0.40.11', error: null } : { ok: false, version: null, error: 'refused' }
    ),
    loaded: vi.fn(async () => [
      { name: 'qwen3:8b', sizeBytes: 6 * GiB, vramBytes: 0, contextLength: 4096, expiresAt: null },
    ]),
    list: vi.fn(async () => []),
    inspect: vi.fn(),
  };
}

function options(rootDir: string, overrides: Partial<ModelHostProbeOptions> = {}): ModelHostProbeOptions {
  return {
    rootDir,
    exec,
    platform: 'linux',
    arch: 'x64',
    env: {},
    os: { totalmem: () => 64 * GiB },
    statfs: async () => ({ bavail: 1000, bsize: 4096 }),
    realpath: async path => path,
    runtime: runtime(),
    ...overrides,
  };
}

describe('parseOsRelease and parseCpuinfo', () => {
  it('reads the pretty name', () => {
    expect(parseOsRelease('NAME=Fedora\nPRETTY_NAME="Fedora Linux 41 (Server Edition)"\n')).toBe(
      'Fedora Linux 41 (Server Edition)'
    );
    expect(parseOsRelease('NAME=x\n')).toBeNull();
  });

  it('counts physical cores and logical processors', () => {
    expect(parseCpuinfo(CPUINFO)).toEqual({ model: 'AMD Ryzen 7 5800X 8-Core Processor', cores: 2, threads: 4 });
    expect(parseCpuinfo('processor\t: 0\nModel\t: Raspberry Pi 5\n\nprocessor\t: 1\n')).toEqual({
      model: 'Raspberry Pi 5',
      cores: 2,
      threads: 2,
    });
    expect(parseCpuinfo('')).toEqual({ model: null, cores: null, threads: null });
  });
});

describe('probeModelHost', () => {
  it('reports the official install, its store, settings and the fit runtime they imply', async () => {
    const { host, settings } = await probeModelHost(options(tree(FILES)));
    expect(host).toEqual({
      os: { name: 'Ubuntu 24.04.3 LTS', kernel: '6.8.0-90-generic' },
      cpu: { model: 'AMD Ryzen 7 5800X 8-Core Processor', cores: 2, threads: 4 },
      memory: { totalBytes: 64 * GiB, availableBytes: 50000000 * 1024 },
      gpus: [],
      hardware: expect.objectContaining({ memoryKind: 'cpu', totalMemoryBytes: 64 * GiB, diskFreeBytes: 4096000 }),
      ollama: {
        url: 'http://127.0.0.1:11434',
        reachable: true,
        version: '0.40.11',
        install: { type: 'official', unit: '/etc/systemd/system/ollama.service', binary: '/usr/local/bin/ollama' },
        store: {
          path: '/usr/share/ollama/.ollama/models',
          source: 'service-home',
          mountPoint: '/',
          freeBytes: 4096000,
          confidence: 'high',
        },
        loaded: [{ name: 'qwen3:8b', sizeBytes: 6 * GiB, vramBytes: 0, contextLength: 4096 }],
      },
      fitRuntime: { kind: 'ollama', slots: 2, flashAttn: 'on', kv: { k: 'q8_0', v: 'q8_0' } },
      fitRuntimeConfidence: 'high',
      defaultContext: 4096,
    });
    const byKey = Object.fromEntries(settings.settings.map(s => [s.key, s]));
    expect(byKey.OLLAMA_NUM_PARALLEL).toMatchObject({ value: '2', source: { kind: 'override' }, writable: false });
    expect(byKey.OLLAMA_CONTEXT_LENGTH).toEqual({
      key: 'OLLAMA_CONTEXT_LENGTH',
      value: '4096',
      source: { kind: 'default', path: null },
      writable: true,
    });
  });

  it('reads the injected os interfaces and host name to decide the Ollama URL is this machine', async () => {
    const os = (address: string) => ({
      totalmem: () => 64 * GiB,
      hostname: () => 'box',
      networkInterfaces: () =>
        ({ eth0: [{ address, family: 'IPv4' }] }) as unknown as ReturnType<typeof networkInterfaces>,
    });
    const ollamaUrl = 'http://192.168.1.20:11434';
    const listening: ExecLike = async (command, args) => {
      if (command === 'systemctl' && args[0] !== '--user') {
        return { stdout: SHOW.replace('Environment=', 'Environment=OLLAMA_HOST=0.0.0.0 ') };
      }
      throw new Error(`${command} not found`);
    };
    const own = await probeModelHost(options(tree(FILES), { ollamaUrl, exec: listening, os: os('192.168.1.20') }));
    expect(own.host.ollama.install.type).toBe('official');
    expect(own.settings.readable).toBe(true);
    const other = await probeModelHost(options(tree(FILES), { ollamaUrl, exec: listening, os: os('10.9.9.9') }));
    expect(other.host.ollama.install.type).toBe('unknown');
    expect(other.settings.readable).toBe(false);
  });

  it('reports an unreachable Ollama with no loaded models and unreadable settings for an unknown install', async () => {
    const offline = runtime(false);
    const rootDir = tree({ ...FILES, 'proc/812/comm': 'bash\n' });
    const noUnits: ExecLike = async () => {
      throw new Error('Failed to connect to bus');
    };
    const { host, settings } = await probeModelHost(options(rootDir, { runtime: offline, exec: noUnits }));
    expect(host.ollama).toMatchObject({
      reachable: false,
      version: null,
      install: { type: 'unknown' },
      store: { path: null, source: null, mountPoint: null, freeBytes: null },
      loaded: [],
    });
    expect(host.fitRuntime).toEqual({ kind: 'ollama', slots: 1, flashAttn: 'auto' });
    expect(host.fitRuntimeConfidence).toBe('low');
    expect(host.ollama.store.confidence).toBe('low');
    expect(settings).toEqual({ readable: false, settings: [], unreadablePaths: [] });
    expect(offline.loaded).not.toHaveBeenCalled();
    expect(offline.list).not.toHaveBeenCalled();
  });

  it('falls back to an installed model for the store and to os for the CPU', async () => {
    const live = runtime();
    live.list.mockResolvedValue([{ name: 'qwen3:8b' }] as never);
    live.inspect.mockResolvedValue({ contents: { storeDir: '/srv/ollama/models' } } as never);
    const rootDir = tree({ 'proc/self/mountinfo': FILES['proc/self/mountinfo'] });
    const { host } = await probeModelHost(
      options(rootDir, {
        runtime: live,
        exec: async () => {
          throw new Error('no systemctl');
        },
        os: {
          totalmem: () => 8 * GiB,
          cpus: () => [{ model: 'Cortex-A76' }, { model: 'Cortex-A76' }],
          release: () => '6.6.0',
        },
      })
    );
    expect(host.ollama.store).toEqual({
      path: '/srv/ollama/models',
      source: 'installed-model',
      mountPoint: '/',
      freeBytes: 4096000,
      confidence: 'high',
    });
    expect(host.cpu).toEqual({ model: 'Cortex-A76', cores: null, threads: 2 });
    expect(host.os).toEqual({ name: null, kernel: '6.6.0' });
  });

  it('runs nvidia-smi and the sysfs GPU scan once per probe', async () => {
    const calls: string[] = [];
    const smi: ExecLike = async (command, args) => {
      calls.push(command);
      if (command === 'nvidia-smi') return { stdout: 'NVIDIA GeForce RTX 4090, 24564, 812\n' };
      return exec(command, args);
    };
    vi.mocked(scanLinuxGpus).mockClear();
    const { host } = await probeModelHost(options(tree(FILES), { exec: smi }));
    expect(calls.filter(command => command === 'nvidia-smi')).toHaveLength(1);
    expect(scanLinuxGpus).toHaveBeenCalledTimes(1);
    expect(host.hardware).toMatchObject({ gpuName: 'NVIDIA GeForce RTX 4090', gpuMemoryBytes: 24564 * 1024 ** 2 });
    expect(host.gpus).toEqual([
      {
        vendor: 'nvidia',
        name: 'NVIDIA GeForce RTX 4090',
        memoryBytes: 24564 * 1024 ** 2,
        memoryUsedBytes: 812 * 1024 ** 2,
      },
    ]);
  });

  it('tiers the default context on every GPU, across vendors, as Ollama sums them', async () => {
    const gpuQueries = {
      nvidiaSmi: async () => 'NVIDIA GeForce RTX 4080, 16376, 0\n',
      linuxGpus: async () => [{ vendor: 'amd' as const, name: 'Radeon RX 7800 XT', memoryBytes: 16 * GiB }],
    };
    const { host, settings } = await probeModelHost(options(tree(FILES), { gpuQueries }));
    expect(host.hardware.gpuMemoryBytes).toBe(16376 * 1024 ** 2);
    expect(host.defaultContext).toBe(32768);
    expect(settings.settings.find(s => s.key === 'OLLAMA_CONTEXT_LENGTH')?.value).toBe('32768');
  });

  it("finds the store under a unit's Environment=HOME= and keeps every other variable out of the result", async () => {
    const show = SHOW.replace(
      /^Environment=.*$/m,
      'Environment=OLLAMA_NUM_PARALLEL=2 HOME=/srv/ollama-home "PATH=/usr/bin" "OLLAMA_API_KEY=sk-secret"'
    );
    const files = {
      ...FILES,
      'etc/systemd/system/ollama.service':
        '[Service]\nEnvironment=HOME=/srv/ollama-home PATH=/usr/bin OLLAMA_API_KEY=sk-secret\n',
    };
    const unitExec: ExecLike = async (command, args) => {
      if (command === 'systemctl' && args[0] !== '--user') return { stdout: show };
      throw new Error(`${command} not found`);
    };
    const result = await probeModelHost(options(tree(files), { exec: unitExec }));
    expect(result.host.ollama.store).toMatchObject({ path: '/srv/ollama-home/.ollama/models', source: 'service-home' });
    expect(result.ollamaHome).toBe('/srv/ollama-home');
    const text = JSON.stringify(result);
    expect(text).not.toContain('sk-secret');
    expect(text).not.toContain('PATH=');
    expect(text).not.toContain('/usr/bin"');
  });

  it('clamps odd fields to the schema bounds instead of failing the probe', async () => {
    const odd = runtime();
    odd.health.mockResolvedValue({ ok: true, version: 'v'.repeat(1000), error: null });
    odd.loaded.mockResolvedValue(
      Array.from({ length: 100 }, (_, i) => ({
        name: 'm'.repeat(5000),
        sizeBytes: i === 0 ? -1 : 2 ** 60,
        vramBytes: 1.5,
        contextLength: i === 0 ? 0 : 2 ** 30,
        expiresAt: null,
      }))
    );
    const show = SHOW.replace(/^Environment=.*$/m, `Environment=OLLAMA_ORIGINS=${'o'.repeat(5000)}`);
    const longExec: ExecLike = async (command, args) =>
      command === 'systemctl' && args[0] !== '--user' ? { stdout: show } : exec(command, args);
    const rootDir = tree({ ...FILES, 'etc/os-release': `PRETTY_NAME="${'x'.repeat(1000)}"\n` });
    const { host, settings } = await probeModelHost(options(rootDir, { runtime: odd, exec: longExec }));
    expect(host.ollama.version).toHaveLength(256);
    expect(host.os.name).toHaveLength(256);
    expect(host.ollama.loaded).toHaveLength(64);
    expect(host.ollama.loaded[0]).toEqual({ name: 'm'.repeat(1024), sizeBytes: 0, vramBytes: 2, contextLength: null });
    expect(host.ollama.loaded[1]).toMatchObject({ sizeBytes: 2 ** 53 - 1, contextLength: null });
    expect(settings.settings.find(s => s.key === 'OLLAMA_ORIGINS')?.value).toHaveLength(4096);
  });
});
