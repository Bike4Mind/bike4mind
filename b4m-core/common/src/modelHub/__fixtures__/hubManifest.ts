import type { HubManifestInput } from '../../schemas/modelHub';
import type { HardwareProfile } from '../fit';
import type { RuntimePins } from '../grade';

// Synthetic catalog for estimator and selector tests. Shapes and sizes resemble real 2026 builds, but none of
// this is curated data: the real catalog lands with our own evals.

type EntryInput = HubManifestInput['entries'][number];
type BuildInput = EntryInput['builds'][number];
type EvidenceInput = BuildInput['evidence'][number];

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

export const PINS: RuntimePins = { ollama: '0.40.11', 'llama-server': 'b11889', evalSuite: 'b4m-local-v1' };
export const OLD_PINS: RuntimePins = { ollama: '0.30.0', 'llama-server': 'b10430', evalSuite: 'b4m-local-v1' };

export const sha = (n: number) => n.toString(16).padStart(64, '0');
const REV = 'c'.repeat(40);

export function ownEval(
  digest: string,
  over: {
    runtime?: 'ollama' | 'llama-server';
    version?: string;
    exact?: number;
    malformed?: number;
    coding?: number;
    /** Adds the parent-model tool-call run a Tier C listing needs. */
    parent?: boolean;
  } = {}
): EvidenceInput {
  const runtime = over.runtime ?? 'llama-server';
  const toolCall = { exact: over.exact ?? 18, nearMiss: 0, malformed: over.malformed ?? 0, of: 20 };
  return {
    kind: 'own-eval',
    source: 'https://example.com/evals/run.json',
    metric: 'b4m-local-v1 tool-call exact',
    value: over.exact ?? 18,
    measured: { target: 'exact', sha256: digest },
    independent: true,
    reproducible: true,
    date: '2026-10-20',
    ownEval: {
      suite: 'b4m-local-v1',
      hardware: 'm4max-128',
      runtime,
      runtimeVersion: over.version ?? PINS[runtime],
      presetHash: sha(999),
      context: 65536,
      kv: 'q8_0',
      toolCall,
      ...(over.parent ? { parentToolCall: { ...toolCall, exact: toolCall.exact - 1 } } : {}),
      coding: { passed: over.coding ?? 8, of: 10 },
      recall: { passed: 5, of: 5 },
      decodeTokS: 30,
      prefillTokS: 400,
      peakBytes: 20 * GIB,
      estimateBytes: 21 * GIB,
      thinkingTokensMedian: 300,
    },
  };
}

export function siblingBenchmark(): EvidenceInput {
  return {
    kind: 'benchmark',
    source: 'https://example.com/study',
    metric: 'normalized accuracy vs BF16',
    value: 0.99,
    measured: { target: 'sibling', file: 'other-quant.gguf' },
    independent: true,
    reproducible: true,
    date: '2026-10-01',
  };
}

const smokeOk = (runtime: 'ollama' | 'llama-server', version = PINS[runtime]): BuildInput['smoke'][number] => ({
  runtime,
  runtimeVersion: version,
  date: '2026-10-21',
  pass: true,
  checks: ['acquire', 'show', 'load', 'plain', 'tool'],
  ...(runtime === 'llama-server' ? { kv: 'q8_0' as const } : {}),
});

let digestSeq = 1;

export function build(
  id: string,
  sizeBytes: number,
  over: Omit<Partial<BuildInput>, 'evidence'> & { evidence?: (digest: string) => EvidenceInput[] } = {}
): BuildInput {
  const digest = sha(digestSeq++);
  const { evidence, ...rest } = over;
  return {
    id,
    hf: { repo: 'example/Model-GGUF', revision: REV },
    quant: { label: id.toUpperCase(), family: 'K', scheme: 'imatrix', bpw: 4.8 },
    weights: [{ path: `model-${id}.gguf`, sizeBytes, sha256: digest }],
    routing: { preferred: 'llama-server', reasons: ['per-model-kv'], ollamaFallback: false },
    smoke: [smokeOk('llama-server')],
    ...rest,
    evidence: evidence ? evidence(digest) : [ownEval(digest)],
  };
}

const license = (cls: 'permissive' | 'restricted-commercial' = 'permissive') => ({
  id: cls === 'permissive' ? 'Apache-2.0' : 'example-community-1.0',
  spdx: cls === 'permissive',
  class: cls,
  source: 'https://example.com/LICENSE',
  base: { id: 'Apache-2.0', spdx: true, class: 'permissive' as const, source: 'https://example.com/base/LICENSE' },
  cardTag: null,
  gated: false,
  legal: 'cleared' as const,
  ...(cls === 'permissive'
    ? {}
    : {
        legalNote: 'Local use cleared for desktop download.',
        requiresAck: true,
        summary: 'Free for local use; offering it as a hosted service needs a separate license.',
      }),
});

const flags = { abliterated: false, experimental: false, licenseMismatch: false, customQuant: false };
const caps = { tools: true, vision: false, thinking: true, embeddings: false };

function entry(over: Partial<EntryInput> & Pick<EntryInput, 'id' | 'arch' | 'builds' | 'roles'>): EntryInput {
  return {
    name: over.id,
    family: 'hybrid',
    why: 'Fixture entry.',
    lineage: { base: 'example/Base', variantType: 'requant', producer: { name: 'unsloth', tier: 'A' } },
    license: license(),
    params: { totalB: 27, activeB: null },
    capabilities: caps,
    flags,
    reviewedAt: '2026-10-21',
    ...over,
  };
}

// Qwen3.8-27B-like: 16 full-attention layers of 64 (64 KiB/token f16), the rest Gated DeltaNet.
export const HYBRID_27B_ARCH = {
  contextMax: 262144,
  blockCount: 64,
  full: { layers: 16, kvHeads: 4, keyLength: 256, valueLength: 256 },
  recurrent: { layers: 48, stateBytesPerSeq: 150 * MIB, kind: 'gated-delta-net' as const },
};

// 35B-A3B hybrid MoE: 20 KiB/token f16, 40 MoE layers.
export const MOE_35B_ARCH = {
  contextMax: 262144,
  blockCount: 40,
  full: { layers: 10, kvHeads: 2, keyLength: 256, valueLength: 256 },
  recurrent: { layers: 30, stateBytesPerSeq: 60 * MIB, kind: 'gated-delta-net' as const },
  moe: { experts: 256, used: 8, moeLayers: 40 },
};

// Gemma-like 12B: 8 global layers (64 KiB/token) and 40 sliding-window layers of 1024.
export const GEMMA_12B_ARCH = {
  contextMax: 131072,
  blockCount: 48,
  full: { layers: 8, kvHeads: 8, keyLength: 256, valueLength: 256 },
  swa: { layers: 40, kvHeads: 8, keyLength: 256, valueLength: 256, window: 1024 },
};

// Plain GQA 9B: 144 KiB/token f16.
export const DENSE_9B_ARCH = {
  contextMax: 131072,
  blockCount: 36,
  full: { layers: 36, kvHeads: 8, keyLength: 128, valueLength: 128 },
};

const EMBED_ARCH = {
  contextMax: 32768,
  blockCount: 28,
  full: { layers: 28, kvHeads: 8, keyLength: 128, valueLength: 128 },
};

const sampling = { temperature: 0.6, top_p: 0.95, top_k: 20 };
const family = (ggufArch: string) => ({
  ggufArch,
  sampling: { thinking: sampling },
  reasoning: { via: 'kwarg' as const, key: 'enable_thinking' as const, levels: { off: false, high: true } },
  ollama: {},
  source: 'https://example.com/generation_config.json',
});

export function fixtureManifest(): HubManifestInput {
  digestSeq = 1;
  return {
    schemaVersion: 2,
    updatedAt: '2026-10-26T00:00:00Z',
    families: { hybrid: family('qwen35'), moe: family('qwen35moe'), gemma: family('gemma3'), dense: family('llama') },
    rankings: {
      code: ['hybrid-27b', 'experimental-agent', 'dense-9b-tuned', 'moe-35b', 'hybrid-27b-abliterated'],
      chat: ['moe-35b', 'gemma-12b', 'hybrid-27b', 'restricted-moe', 'dense-9b-tuned'],
      vision: ['gemma-12b'],
      embeddings: ['embed-small'],
    },
    entries: [
      entry({
        id: 'hybrid-27b',
        roles: ['code', 'chat'],
        arch: HYBRID_27B_ARCH,
        builds: [
          build('q6', 21.98e9),
          build('iq4', 13.08e9, { evidence: d => [ownEval(d), siblingBenchmark()] }),
          build('iq3', 11.04e9, {
            ollama: { kind: 'create', modelfile: { renderer: 'qwen3.5', parser: 'qwen3.5' } },
            routing: { preferred: 'llama-server', reasons: ['per-model-kv'], ollamaFallback: true },
            smoke: [smokeOk('llama-server'), smokeOk('ollama')],
            evidence: d => [ownEval(d, { version: OLD_PINS['llama-server'] })],
          }),
        ],
      }),
      entry({
        id: 'moe-35b',
        family: 'moe',
        roles: ['chat', 'code'],
        params: { totalB: 35, activeB: 3 },
        arch: MOE_35B_ARCH,
        builds: [
          build('q4', 21.71e9, {
            tensorStats: { expertBytesPerLayer: 492_750_000, nonExpertBytes: 2_000_000_000 },
            routing: { preferred: 'llama-server', reasons: ['expert-offload'], ollamaFallback: false },
            evidence: d => [ownEval(d, { exact: 16, coding: 7 })],
          }),
        ],
      }),
      entry({
        id: 'gemma-12b',
        family: 'gemma',
        roles: ['chat', 'vision'],
        params: { totalB: 12, activeB: null },
        capabilities: { ...caps, vision: true },
        arch: GEMMA_12B_ARCH,
        builds: [
          build('q4', 7.37e9, {
            mmproj: { path: 'mmproj-F32.gguf', sizeBytes: 0.21e9, sha256: sha(500) },
            ollama: { kind: 'create', modelfile: { renderer: 'gemma4', parser: 'gemma4' } },
            routing: { preferred: 'ollama', reasons: ['renderer-known'], ollamaFallback: true },
            smoke: [smokeOk('ollama'), smokeOk('llama-server')],
            evidence: d => [ownEval(d, { runtime: 'ollama', exact: 15 }), ownEval(d, { exact: 15 })],
          }),
        ],
      }),
      entry({
        id: 'dense-9b-tuned',
        family: 'dense',
        roles: ['chat', 'code'],
        params: { totalB: 9, activeB: null },
        lineage: { base: 'example/Base-9B', variantType: 'fine-tune', producer: { name: 'ornith-ai', tier: 'B' } },
        arch: DENSE_9B_ARCH,
        builds: [build('q4', 5.78e9, { evidence: d => [ownEval(d, { exact: 19, coding: 9 })] })],
      }),
      entry({
        id: 'hybrid-27b-abliterated',
        roles: ['code'],
        lineage: {
          base: 'example/Base',
          variantType: 'abliterated',
          steps: ['abliterate'],
          producer: { name: 'huihui-ai', tier: 'C' },
        },
        flags: { ...flags, abliterated: true },
        arch: HYBRID_27B_ARCH,
        builds: [build('iq4', 13.08e9, { evidence: d => [ownEval(d, { exact: 20, coding: 10, parent: true })] })],
      }),
      entry({
        id: 'restricted-moe',
        family: 'moe',
        roles: ['chat'],
        params: { totalB: 35, activeB: 3 },
        license: license('restricted-commercial'),
        arch: MOE_35B_ARCH,
        builds: [build('iq3', 12e9, { evidence: d => [ownEval(d, { exact: 20, coding: 10 })] })],
      }),
      entry({
        id: 'experimental-agent',
        roles: ['code'],
        flags: { ...flags, experimental: true },
        arch: HYBRID_27B_ARCH,
        builds: [build('q3', 9e9, { evidence: d => [ownEval(d, { exact: 20, coding: 10 })] })],
      }),
      entry({
        id: 'embed-small',
        family: 'dense',
        roles: ['embeddings'],
        params: { totalB: 0.6, activeB: null },
        capabilities: { tools: false, vision: false, thinking: false, embeddings: true },
        arch: EMBED_ARCH,
        builds: [
          build('q8', 0.64e9, {
            ollama: { kind: 'library', ref: 'embed-small:0.6b', sizeBytes: 639_150_000, digest: sha(900) },
            routing: { preferred: 'ollama', reasons: ['library-tag'], ollamaFallback: true },
            smoke: [smokeOk('ollama')],
            evidence: () => [ownEval(sha(900), { runtime: 'ollama' })],
          }),
        ],
      }),
    ],
  };
}

export function machine(
  memoryKind: HardwareProfile['memoryKind'],
  ramGiB: number,
  vramGiB: number | null = null
): HardwareProfile {
  return {
    platform: memoryKind === 'unified' ? 'darwin' : 'linux',
    arch: memoryKind === 'unified' ? 'arm64' : 'x64',
    memoryKind,
    totalMemoryBytes: ramGiB * GIB,
    gpuMemoryBytes: vramGiB === null ? null : vramGiB * GIB,
    gpuName: null,
    gpuCount: vramGiB === null ? 0 : 1,
    chip: null,
    diskFreeBytes: null,
    confidence: 'high',
  };
}
