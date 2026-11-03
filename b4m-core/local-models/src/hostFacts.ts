import { readFile } from 'node:fs/promises';
import nodeOs from 'node:os';
import { join } from 'node:path';
import {
  HostFactsSchema,
  MODEL_HOST_LIMITS,
  OllamaSettingsSchema,
  type HostFacts,
  type OllamaSettings,
} from '@bike4mind/common/modelHub';
import {
  gpuQueries,
  probeHardware,
  probeMemoryUsage,
  type HardwareProbeOptions,
  type HardwareProfile,
} from './hardware';
import { DEFAULT_OLLAMA_URL, OllamaRuntime } from './ollama';
import { detectOllamaInstall, machineAddresses, readOllamaSettings } from './ollamaInstall';
import { fitRuntimeFromOllamaSettings, ollamaDefaultContext, ollamaFitConfidence } from './ollamaSettings';
import { resolveStorePath, serviceHome, storeDisk, type StoreDiskOptions } from './storeDisk';
import type { LocalRuntime } from './types';

/** PRETTY_NAME from `/etc/os-release`. */
export function parseOsRelease(text: string): string | null {
  const match = /^PRETTY_NAME=(.*)$/m.exec(text);
  const value = match?.[1].trim().replace(/^(["'])(.*)\1$/, '$2');
  return value || null;
}

/** The CPU model, physical cores and logical processors from `/proc/cpuinfo`. */
export function parseCpuinfo(text: string): { model: string | null; cores: number | null; threads: number | null } {
  let model: string | null = null;
  let threads = 0;
  const cores = new Set<string>();
  for (const block of text.split(/\n\s*\n/)) {
    const field = (name: string) => new RegExp(`^${name}\\s*:\\s*(.*)$`, 'm').exec(block)?.[1].trim();
    if (field('processor') === undefined) continue;
    threads++;
    model ??= field('model name') || field('Model') || field('Hardware') || null;
    const physical = field('physical id');
    const core = field('core id');
    if (physical !== undefined && core !== undefined) cores.add(`${physical}:${core}`);
  }
  return { model, cores: cores.size || (threads ? threads : null), threads: threads || null };
}

export interface ModelHostProbeOptions extends HardwareProbeOptions, Pick<StoreDiskOptions, 'realpath'> {
  ollamaUrl?: string;
  /** Defaults to an OllamaRuntime at `ollamaUrl`. */
  runtime?: Pick<LocalRuntime, 'health' | 'loaded' | 'list' | 'inspect'>;
  unitName?: string;
  homeDir?: string;
  os?: {
    totalmem(): number;
    cpus?(): Array<{ model: string }>;
    release?(): string;
    networkInterfaces?(): ReturnType<typeof nodeOs.networkInterfaces>;
    hostname?(): string;
  };
}

export interface ModelHostProbe {
  host: HostFacts;
  settings: OllamaSettings;
  /** The home Ollama runs with, where it keeps `.ollama/id_ed25519.pub`; null when unknown. Not sent to clients. */
  ollamaHome: string | null;
}

const readText = (path: string) => readFile(path, 'utf8').catch(() => null);

const L = MODEL_HOST_LIMITS;
const clip = (text: string | null | undefined, max: number = L.text) =>
  typeof text === 'string' ? text.slice(0, max) : null;
const clipBytes = (value: number | null | undefined) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(Math.round(value), L.bytes) : null;
const clipCount = (value: number | null | undefined) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(Math.round(value), L.count) : null;
const clipContext = (value: number | null | undefined) =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= L.context ? value : null;

function clipHardware(hardware: HardwareProfile): HardwareProfile {
  return {
    ...hardware,
    platform: clip(hardware.platform) ?? '',
    arch: clip(hardware.arch) ?? '',
    totalMemoryBytes: clipBytes(hardware.totalMemoryBytes) ?? 0,
    gpuMemoryBytes: clipBytes(hardware.gpuMemoryBytes),
    gpuName: clip(hardware.gpuName),
    gpuCount: clipCount(hardware.gpuCount) ?? 0,
    chip: clip(hardware.chip),
    diskFreeBytes: clipBytes(hardware.diskFreeBytes),
  };
}

function clipSettings(settings: OllamaSettings): OllamaSettings {
  return {
    ...settings,
    settings: settings.settings.map(setting => ({
      ...setting,
      value: clip(setting.value, L.path),
      source: { ...setting.source, path: clip(setting.source.path, L.path) },
    })),
    unreadablePaths: settings.unreadablePaths.slice(0, L.unreadable).map(path => path.slice(0, L.path)),
  };
}

/** Facts a model host reports about its machine and the Ollama beside it. Never throws on missing data. */
export async function probeModelHost(options: ModelHostProbeOptions = {}): Promise<ModelHostProbe> {
  const url = options.ollamaUrl ?? DEFAULT_OLLAMA_URL;
  const root = options.rootDir ?? '/';
  const os = options.os ?? nodeOs;
  const { networkInterfaces, hostname } = os;
  const ownAddresses =
    networkInterfaces && hostname
      ? machineAddresses({ networkInterfaces: () => networkInterfaces.call(os), hostname: () => hostname.call(os) })
      : undefined;
  const runtime = options.runtime ?? new OllamaRuntime({ baseUrl: url });

  const [health, install, osRelease, kernel, cpuinfo] = await Promise.all([
    runtime.health(),
    detectOllamaInstall({
      url,
      exec: options.exec,
      rootDir: options.rootDir,
      unitName: options.unitName,
      localAddresses: ownAddresses,
    }),
    readText(join(root, 'etc/os-release')),
    readText(join(root, 'proc/sys/kernel/osrelease')),
    readText(join(root, 'proc/cpuinfo')),
  ]);
  const loaded = health.ok ? await runtime.loaded().catch(() => []) : [];
  const { settings, env } = await readOllamaSettings(install, { rootDir: options.rootDir, homeDir: options.homeDir });

  const store = await resolveStorePath({
    env,
    unit: install.unit,
    rootDir: options.rootDir,
    homeDir: options.homeDir,
    installedStoreDir: async () => {
      if (!health.ok) return null;
      const [first] = await runtime.list();
      return first ? ((await runtime.inspect(first.name)).contents?.storeDir ?? null) : null;
    },
  });
  const disk = store.path
    ? await storeDisk(store.path, { rootDir: options.rootDir, statfs: options.statfs, realpath: options.realpath })
    : { mountPoint: null, freeBytes: null, resolved: false };

  const shared = { ...options, gpuQueries: options.gpuQueries ?? gpuQueries(options) };
  const [measured, usage] = await Promise.all([
    probeHardware({ ...shared, modelDir: disk.mountPoint ?? store.path ?? undefined }),
    probeMemoryUsage(shared),
  ]);
  const hardware = clipHardware({ ...measured, diskFreeBytes: disk.freeBytes ?? measured.diskFreeBytes });
  const gpuTotals = usage.gpus.map(gpu => gpu.memoryBytes);
  const defaultContext = ollamaDefaultContext(hardware, env, gpuTotals);
  const vramContext = ollamaDefaultContext(hardware, { ...env, OLLAMA_CONTEXT_LENGTH: undefined }, gpuTotals);
  const cpu = cpuinfo ? parseCpuinfo(cpuinfo) : { model: null, cores: null, threads: null };

  const host = HostFactsSchema.parse({
    os: {
      name: clip(osRelease ? parseOsRelease(osRelease) : null),
      kernel: clip(kernel?.trim() || os.release?.() || null),
    },
    cpu: {
      model: clip(cpu.model ?? os.cpus?.()[0]?.model ?? null),
      cores: clipCount(cpu.cores),
      threads: clipCount(cpu.threads ?? (os.cpus?.().length || null)),
    },
    memory: { totalBytes: hardware.totalMemoryBytes, availableBytes: clipBytes(usage.availableMemoryBytes) },
    gpus: usage.gpus.slice(0, L.gpus).map(gpu => ({
      vendor: gpu.vendor,
      name: clip(gpu.name),
      memoryBytes: clipBytes(gpu.memoryBytes),
      memoryUsedBytes: clipBytes(gpu.memoryUsedBytes),
    })),
    hardware,
    ollama: {
      url: url.slice(0, L.url),
      reachable: health.ok,
      version: clip(health.version),
      install: {
        type: install.install.type,
        unit: clip(install.install.unit, L.path),
        binary: clip(install.install.binary, L.path),
      },
      store: {
        path: clip(store.path, L.path),
        source: store.source,
        mountPoint: clip(disk.mountPoint, L.path),
        freeBytes: clipBytes(disk.freeBytes),
        confidence: store.path && disk.resolved ? 'high' : 'low',
      },
      loaded: loaded.slice(0, L.loaded).map(({ name, sizeBytes, vramBytes, contextLength }) => ({
        name: name.slice(0, L.modelName),
        sizeBytes: clipBytes(sizeBytes) ?? 0,
        vramBytes: clipBytes(vramBytes) ?? 0,
        contextLength: clipContext(contextLength),
      })),
    },
    fitRuntime: fitRuntimeFromOllamaSettings(env),
    fitRuntimeConfidence: settings.readable ? ollamaFitConfidence(env) : 'low',
    defaultContext,
  });
  const reported = OllamaSettingsSchema.parse(
    clipSettings({
      ...settings,
      settings: settings.settings.map(setting =>
        setting.key === 'OLLAMA_CONTEXT_LENGTH' && setting.source.kind === 'default'
          ? { ...setting, value: String(vramContext) }
          : setting
      ),
    })
  );
  const ollamaHome = await serviceHome({
    env,
    unit: install.unit,
    rootDir: options.rootDir,
    homeDir: options.homeDir,
  }).catch(() => null);
  return { host, settings: reported, ollamaHome };
}
