import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  OLLAMA_ENV_KEYS,
  fitRuntimeFromOllamaSettings,
  isOllamaEnvKey,
  ollamaDefaultContext,
  ollamaEnvValue,
  ollamaFitConfidence,
  type OllamaEnvironment,
} from './ollamaSettings';

const GiB = 1024 ** 3;
const discrete = (gpuMemoryBytes: number | null, gpuCount = 1) => ({
  memoryKind: 'discrete' as const,
  totalMemoryBytes: 64 * GiB,
  gpuMemoryBytes,
  gpuCount,
});
const cpu = { memoryKind: 'cpu' as const, totalMemoryBytes: 64 * GiB, gpuMemoryBytes: null, gpuCount: 0 };

describe('ollamaEnvValue', () => {
  it('strips spaces and quotes as envconfig.Var does', () => {
    expect(ollamaEnvValue({ OLLAMA_KV_CACHE_TYPE: ' "q8_0" ' }, 'OLLAMA_KV_CACHE_TYPE')).toBe('q8_0');
    expect(ollamaEnvValue({}, 'OLLAMA_KV_CACHE_TYPE')).toBe('');
  });
});

describe('the Ollama environment allowlist', () => {
  it('admits the settings, the GPU overhead and HOME, and nothing else', () => {
    expect(OLLAMA_ENV_KEYS.size).toBe(12);
    for (const key of ['OLLAMA_HOST', 'OLLAMA_MODELS', 'OLLAMA_GPU_OVERHEAD', 'HOME'])
      expect(isOllamaEnvKey(key)).toBe(true);
    for (const key of ['PATH', 'OLLAMA_API_KEY', 'HTTPS_PROXY', 'constructor']) expect(isOllamaEnvKey(key)).toBe(false);
    expectTypeOf<keyof OllamaEnvironment>().toEqualTypeOf<
      | 'HOME'
      | 'OLLAMA_GPU_OVERHEAD'
      | 'OLLAMA_HOST'
      | 'OLLAMA_CONTEXT_LENGTH'
      | 'OLLAMA_KEEP_ALIVE'
      | 'OLLAMA_NUM_PARALLEL'
      | 'OLLAMA_MAX_LOADED_MODELS'
      | 'OLLAMA_FLASH_ATTENTION'
      | 'OLLAMA_KV_CACHE_TYPE'
      | 'OLLAMA_NO_CLOUD'
      | 'OLLAMA_MODELS'
      | 'OLLAMA_ORIGINS'
    >();
  });
});

describe('fitRuntimeFromOllamaSettings', () => {
  it('plans one slot, automatic flash attention and the default KV cache when nothing is set', () => {
    expect(fitRuntimeFromOllamaSettings({})).toEqual({ kind: 'ollama', slots: 1, flashAttn: 'auto' });
  });

  it('reads parallel slots, flash attention and the KV cache type', () => {
    expect(
      fitRuntimeFromOllamaSettings({
        OLLAMA_NUM_PARALLEL: '3',
        OLLAMA_FLASH_ATTENTION: 'true',
        OLLAMA_KV_CACHE_TYPE: 'Q8_0',
      })
    ).toEqual({ kind: 'ollama', slots: 3, flashAttn: 'on', kv: { k: 'q8_0', v: 'q8_0' } });
    expect(fitRuntimeFromOllamaSettings({ OLLAMA_FLASH_ATTENTION: '0', OLLAMA_KV_CACHE_TYPE: 'q4_0' })).toEqual({
      kind: 'ollama',
      slots: 1,
      flashAttn: 'off',
      kv: { k: 'q4_0', v: 'q4_0' },
    });
  });

  it('follows Ollama on malformed values: a non-number keeps one slot, any other flag text is on', () => {
    expect(
      fitRuntimeFromOllamaSettings({
        OLLAMA_NUM_PARALLEL: 'four',
        OLLAMA_FLASH_ATTENTION: 'yes',
        OLLAMA_KV_CACHE_TYPE: 'iq4_nl',
      })
    ).toEqual({ kind: 'ollama', slots: 1, flashAttn: 'on', kv: { k: 'q4_0', v: 'q4_0' } });
    expect(fitRuntimeFromOllamaSettings({ OLLAMA_NUM_PARALLEL: '0' }).slots).toBe(1);
  });

  it("prices llama-server's other cache types with a stand-in no smaller, and flags what it cannot price exactly", () => {
    const kv = (type: string) => fitRuntimeFromOllamaSettings({ OLLAMA_KV_CACHE_TYPE: type }).kv;
    const confidence = (type: string) => ollamaFitConfidence({ OLLAMA_KV_CACHE_TYPE: type });
    expect([kv('BF16'), confidence('bf16')]).toEqual([{ k: 'f16', v: 'f16' }, 'high']);
    expect([kv('iq4_nl'), confidence('iq4_nl')]).toEqual([{ k: 'q4_0', v: 'q4_0' }, 'high']);
    for (const type of ['q4_1', 'q5_0', 'q5_1']) {
      expect([kv(type), confidence(type)]).toEqual([{ k: 'q8_0', v: 'q8_0' }, 'low']);
    }
    expect([kv('f32'), confidence('f32')]).toEqual([undefined, 'low']);
    expect([kv('bogus'), confidence('bogus')]).toEqual([undefined, 'low']);
    expect(ollamaFitConfidence({})).toBe('high');
    expect(ollamaFitConfidence({ OLLAMA_KV_CACHE_TYPE: 'q8_0' })).toBe('high');
  });
});

describe('ollamaDefaultContext', () => {
  it('uses OLLAMA_CONTEXT_LENGTH when set to a whole number', () => {
    expect(ollamaDefaultContext(cpu, { OLLAMA_CONTEXT_LENGTH: '8192' })).toBe(8192);
    expect(ollamaDefaultContext(cpu, { OLLAMA_CONTEXT_LENGTH: '8k' })).toBe(4096);
  });

  it('tiers by total VRAM with the 23 and 47 GiB thresholds', () => {
    expect(ollamaDefaultContext(cpu)).toBe(4096);
    expect(ollamaDefaultContext(discrete(null))).toBe(4096);
    expect(ollamaDefaultContext(discrete(16 * GiB))).toBe(4096);
    expect(ollamaDefaultContext(discrete(23.9 * GiB))).toBe(32768);
    expect(ollamaDefaultContext(discrete(48 * GiB, 2))).toBe(262144);
  });

  it('subtracts OLLAMA_GPU_OVERHEAD per GPU', () => {
    expect(ollamaDefaultContext(discrete(48 * GiB, 2), { OLLAMA_GPU_OVERHEAD: String(1 * GiB) })).toBe(32768);
  });

  it('sums every measured GPU across vendors, less the overhead each, wrapping as uint64 like Ollama', () => {
    // The profile counts one vendor's 16 GiB; Ollama sums the 16 GiB NVIDIA and 16 GiB AMD cards.
    const profile = discrete(16 * GiB, 1);
    expect(ollamaDefaultContext(profile, {}, [16 * GiB, 16 * GiB])).toBe(32768);
    expect(ollamaDefaultContext(profile, { OLLAMA_GPU_OVERHEAD: String(GiB) }, [24 * GiB, 24 * GiB])).toBe(32768);
    expect(ollamaDefaultContext(profile, { OLLAMA_GPU_OVERHEAD: String(20 * GiB) }, [16 * GiB])).toBe(262144);
    expect(ollamaDefaultContext(profile, {}, [16 * GiB, null])).toBe(4096);
    expect(ollamaDefaultContext(profile, {}, [])).toBe(4096);
  });

  it('counts the shared pool of a unified GPU without its own size', () => {
    const unified = { memoryKind: 'unified' as const, totalMemoryBytes: 64 * GiB, gpuMemoryBytes: null, gpuCount: 1 };
    expect(ollamaDefaultContext(unified)).toBe(262144);
    expect(ollamaDefaultContext({ ...unified, gpuWorkingSetBytes: 40 * GiB })).toBe(32768);
  });
});
