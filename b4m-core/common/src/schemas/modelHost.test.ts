import { describe, expect, it } from 'vitest';
import { HostFactsSchema, MODEL_HOST_LIMITS, ModelHostHelloSchema, OllamaSettingsSchema } from './modelHost';

const facts = {
  os: { name: 'Ubuntu 24.04.3 LTS', kernel: '6.8.0-90-generic' },
  cpu: { model: 'AMD Ryzen 7 5800X', cores: 8, threads: 16 },
  memory: { totalBytes: 68719476736, availableBytes: 51200000000 },
  gpus: [{ vendor: 'nvidia', name: 'NVIDIA GeForce RTX 4090', memoryBytes: 25757220864, memoryUsedBytes: 851443712 }],
  hardware: {
    platform: 'linux',
    arch: 'x64',
    memoryKind: 'discrete',
    totalMemoryBytes: 68719476736,
    gpuMemoryBytes: 25757220864,
    gpuName: 'NVIDIA GeForce RTX 4090',
    gpuCount: 1,
    gpuVendor: 'nvidia',
    chip: null,
    diskFreeBytes: 1024000000000,
    confidence: 'high',
  },
  ollama: {
    url: 'http://127.0.0.1:11434',
    reachable: true,
    version: '0.40.11',
    install: { type: 'official', unit: '/etc/systemd/system/ollama.service', binary: '/usr/local/bin/ollama' },
    store: {
      path: '/usr/share/ollama/.ollama/models',
      source: 'service-home',
      mountPoint: '/',
      freeBytes: 1024000000000,
      confidence: 'high',
    },
    loaded: [{ name: 'qwen3:8b', sizeBytes: 6442450944, vramBytes: 6442450944, contextLength: 32768 }],
  },
  fitRuntime: { kind: 'ollama', slots: 2, flashAttn: 'on', kv: { k: 'q8_0', v: 'q8_0' } },
  fitRuntimeConfidence: 'high',
  defaultContext: 32768,
};

describe('HostFactsSchema', () => {
  it('accepts what a model host reports', () => {
    expect(HostFactsSchema.parse(facts)).toEqual(facts);
  });

  it('refuses unbounded lists, unknown install types and KV types the planner does not know', () => {
    const gpus = Array.from({ length: 65 }, () => facts.gpus[0]);
    expect(HostFactsSchema.safeParse({ ...facts, gpus }).success).toBe(false);
    const install = { ...facts.ollama.install, type: 'brew' };
    expect(HostFactsSchema.safeParse({ ...facts, ollama: { ...facts.ollama, install } }).success).toBe(false);
    const fitRuntime = { ...facts.fitRuntime, kv: { k: 'iq4_nl', v: 'iq4_nl' } };
    expect(HostFactsSchema.safeParse({ ...facts, fitRuntime }).success).toBe(false);
  });
});

describe('OllamaSettingsSchema', () => {
  it('accepts allowlisted keys only', () => {
    const setting = {
      key: 'OLLAMA_NUM_PARALLEL',
      value: '2',
      source: { kind: 'override', path: '/etc/systemd/system/ollama.service.d/override.conf' },
      writable: false,
    };
    expect(OllamaSettingsSchema.safeParse({ readable: true, settings: [setting], unreadablePaths: [] }).success).toBe(
      true
    );
    const foreign = { ...setting, key: 'LD_PRELOAD' };
    expect(OllamaSettingsSchema.safeParse({ readable: true, settings: [foreign], unreadablePaths: [] }).success).toBe(
      false
    );
  });

  it("accepts Ollama's server.json as a source and a value waiting on a restart", () => {
    const cloud = {
      key: 'OLLAMA_NO_CLOUD',
      value: '1',
      source: { kind: 'config', path: '/usr/share/ollama/.ollama/server.json' },
      writable: false,
    };
    const pending = {
      ...cloud,
      key: 'OLLAMA_NUM_PARALLEL',
      source: { kind: 'process', path: null },
      pendingRestart: true,
    };
    const settings = { readable: true, settings: [cloud, pending], unreadablePaths: [] };
    expect(OllamaSettingsSchema.parse(settings)).toEqual(settings);
    const tooMany = {
      ...settings,
      unreadablePaths: Array.from({ length: MODEL_HOST_LIMITS.unreadable + 1 }, () => '/x'),
    };
    expect(OllamaSettingsSchema.safeParse(tooMany).success).toBe(false);
  });

  it("accepts the service manager's environment as a source", () => {
    const setting = {
      key: 'OLLAMA_MODELS',
      value: '/data/models',
      source: { kind: 'manager', path: null },
      writable: false,
    };
    const settings = { readable: true, settings: [setting], unreadablePaths: [] };
    expect(OllamaSettingsSchema.parse(settings)).toEqual(settings);
  });
});

describe('ModelHostHelloSchema', () => {
  const hello = {
    protocol: 1,
    minClientProtocol: 1,
    version: '0.1.0',
    serverId: '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
    mode: 'system',
    role: 'manage',
    ollama: { url: 'http://127.0.0.1:11434', reachable: true, version: '0.40.11' },
    features: ['host', 'settings', 'events'],
  };

  it('accepts a hello and keeps fields a newer host adds out of the parsed value', () => {
    expect(ModelHostHelloSchema.parse({ ...hello, linger: true })).toEqual(hello);
  });

  it('refuses unknown roles and modes', () => {
    expect(ModelHostHelloSchema.safeParse({ ...hello, role: 'root' }).success).toBe(false);
    expect(ModelHostHelloSchema.safeParse({ ...hello, mode: 'cluster' }).success).toBe(false);
  });
});
