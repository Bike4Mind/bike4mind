import { createHash } from 'node:crypto';
import { createReadStream, openAsBlob } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ggufShardLocations, inspectGguf, readGgufMetadata, type GgufHeader, type GgufTensorInfo } from './gguf';
import { OllamaRuntime } from './ollama';
import type { FetchLike, ModelInspection } from './types';

// Opt-in checks against real files, skipped unless these are set; the package README has the command.
const OLLAMA = process.env.LOCAL_MODELS_LIVE_OLLAMA;
const OLLAMA_STORE = process.env.LOCAL_MODELS_LIVE_OLLAMA_STORE;
const MODELS = (process.env.LOCAL_MODELS_LIVE_OLLAMA_MODELS ?? 'qwen2.5:0.5b').split(',').map(m => m.trim());
const GGUF_FILES = (process.env.LOCAL_MODELS_LIVE_GGUF_FILES ?? '')
  .split(',')
  .map(file => file.trim())
  .filter(Boolean);
const HF = process.env.LOCAL_MODELS_LIVE_HF;
const HF_TOKEN = process.env.LOCAL_MODELS_LIVE_HF_TOKEN || undefined;
const LIVE_TIMEOUT_MS = 5 * 60_000;

const expected = ({ arch, tensorStats }: ModelInspection) => ({ arch, tensorStats });

/** The GGUF blob behind an Ollama model, from its manifest in the model store. */
async function ollamaBlob(store: string, model: string): Promise<string> {
  const [repo = model, tag = 'latest'] = model.split(':');
  const path = repo.includes('/') ? repo : `library/${repo}`;
  const manifest = JSON.parse(await readFile(join(store, 'manifests', 'registry.ollama.ai', path, tag), 'utf8')) as {
    layers: { mediaType: string; digest: string }[];
  };
  const layer = manifest.layers.find(entry => entry.mediaType === 'application/vnd.ollama.image.model');
  if (!layer) throw new Error(`${model} has no model layer`);
  return join(store, 'blobs', layer.digest.replace(':', '-'));
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

describe.runIf(OLLAMA && OLLAMA_STORE)('GGUF blobs against live Ollama', () => {
  const runtime = new OllamaRuntime({ baseUrl: OLLAMA });

  it.each(MODELS)('reads the arch and tensor stats inspect reports for %s', async model => {
    const blob = await ollamaBlob(OLLAMA_STORE ?? '', model);
    const inspection = await runtime.inspect(model);
    expect(inspection.arch).not.toBeNull();
    expect(await inspectGguf(blob)).toEqual(expected(inspection));
  });

  it.each(MODELS)('reads the values and tensors verbose /api/show lists for %s', async model => {
    const response = await fetch(`${runtime.baseUrl}/api/show`, {
      method: 'POST',
      body: JSON.stringify({ model, verbose: true }),
    });
    const show = (await response.json()) as { model_info: Record<string, unknown>; tensors: unknown[] };
    const header = await readGgufMetadata(await ollamaBlob(OLLAMA_STORE ?? '', model));
    for (const [key, value] of Object.entries(header.metadata)) {
      // Ollama drops these two, and any float or float array holding a non-finite value (jsonSafeValues in
      // server/gguf_metadata.go); JSON cannot carry a bigint or our omitted-array marker.
      if (key === 'general.name' || key === 'tokenizer.chat_template') continue;
      if (typeof value === 'bigint' || (typeof value === 'object' && !Array.isArray(value))) continue;
      if (typeof value === 'number' && !Number.isFinite(value)) continue;
      if (Array.isArray(value) && value.some(item => typeof item === 'number' && !Number.isFinite(item))) continue;
      expect(show.model_info[key], key).toEqual(value);
    }
    expect(header.tensors.map(({ name, type, shape }) => ({ name, type, shape }))).toEqual(show.tensors);
  });
});

describe.runIf(OLLAMA && GGUF_FILES.length > 0)('GGUF files against live Ollama', () => {
  const runtime = new OllamaRuntime({ baseUrl: OLLAMA });

  it.each(GGUF_FILES)(
    'reads the arch and tensor stats Ollama reports for %s',
    async path => {
      const digest = `sha256:${await sha256(path)}`;
      const blobUrl = `${runtime.baseUrl}/api/blobs/${digest}`;
      if (!(await fetch(blobUrl, { method: 'HEAD' })).ok) {
        const upload = await fetch(blobUrl, { method: 'POST', body: await openAsBlob(path) });
        expect(upload.status).toBe(201);
      }
      const model = 'b4m-local-models-gguf-live:latest';
      const created = await fetch(`${runtime.baseUrl}/api/create`, {
        method: 'POST',
        body: JSON.stringify({ model, files: { [basename(path)]: digest }, stream: false }),
      });
      expect(created.ok, await created.clone().text()).toBe(true);
      try {
        const inspection = await runtime.inspect(model);
        expect(inspection.arch).not.toBeNull();
        expect(await inspectGguf(path)).toEqual(expected(inspection));
      } finally {
        await runtime.remove(model);
      }
    },
    LIVE_TIMEOUT_MS
  );
});

const HF_QWEN25 =
  'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf';
const HF_MOE = [
  'https://huggingface.co/unsloth/Qwen3-30B-A3B-GGUF/resolve/main/Qwen3-30B-A3B-Q4_K_M.gguf',
  'https://huggingface.co/unsloth/gpt-oss-20b-GGUF/resolve/main/gpt-oss-20b-Q4_K_M.gguf',
];
const HF_SPLIT =
  'https://huggingface.co/unsloth/Qwen3-235B-A22B-GGUF/resolve/main/Q4_K_M/Qwen3-235B-A22B-Q4_K_M-00001-of-00003.gguf';
const HF_GEMMA3N = 'https://huggingface.co/unsloth/gemma-3n-E2B-it-GGUF/resolve/main/gemma-3n-E2B-it-Q4_K_M.gguf';

// [elements, bytes] per block for the types these files use, from ggml's type_traits.
const BLOCKS: Record<string, readonly [number, number]> = {
  F32: [1, 4],
  F16: [1, 2],
  BF16: [1, 2],
  Q4_0: [32, 18],
  Q5_0: [32, 22],
  Q5_1: [32, 24],
  Q8_0: [32, 34],
  MXFP4: [32, 17],
  Q4_K: [256, 144],
  Q5_K: [256, 176],
  Q6_K: [256, 210],
};

function bytesOf(tensor: GgufTensorInfo): number {
  const block = BLOCKS[tensor.type];
  if (!block) throw new Error(`no block size for ${tensor.type}`);
  return (tensor.shape.reduce((product, size) => product * size, 1) / block[0]) * block[1];
}

const pad = (bytes: number, alignment: number) => Math.ceil(bytes / alignment) * alignment;

/** Tensor sizes agree with the file when each offset is the padded sum before it and the data fills the file. */
function checkLayout(header: GgufHeader, fileSize: number): void {
  const alignment =
    typeof header.metadata['general.alignment'] === 'number' ? header.metadata['general.alignment'] : 32;
  let next = 0;
  for (const tensor of header.tensors) {
    expect(tensor.offset, tensor.name).toBe(next);
    next += pad(bytesOf(tensor), alignment);
  }
  const dataSize = fileSize - pad(header.headerBytes, alignment);
  expect(next - dataSize).toBeGreaterThanOrEqual(0);
  expect(next - dataSize).toBeLessThan(alignment);
}

function expectedStats(tensors: GgufTensorInfo[]) {
  let total = 0;
  let expert = 0;
  const layers = new Set<string>();
  for (const tensor of tensors) {
    const bytes = bytesOf(tensor);
    total += bytes;
    const layer = /^blk\.(\d+)\.ffn_[a-z_]+_exps\./.exec(tensor.name)?.[1];
    if (layer === undefined) continue;
    expert += bytes;
    layers.add(layer);
  }
  return {
    layers: layers.size,
    stats: { expertBytesPerLayer: Math.round(expert / layers.size), nonExpertBytes: total - expert },
  };
}

interface Counter {
  fetch: FetchLike;
  bytes: number;
  urls: string[];
}

/** A fetch that counts body bytes received and the URLs requested. */
function countingFetch(): Counter {
  const counter: Counter = {
    bytes: 0,
    urls: [],
    fetch: async (input, init) => {
      counter.urls.push(input);
      const response = await fetch(input, init);
      if (!response.body) return response;
      const body = response.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            counter.bytes += chunk.length;
            controller.enqueue(chunk);
          },
        })
      );
      const counted = new Response(body, { status: response.status, headers: response.headers });
      Object.defineProperties(counted, { url: { value: response.url }, redirected: { value: response.redirected } });
      return counted;
    },
  };
  return counter;
}

async function remoteSize(url: string): Promise<number> {
  const headers: Record<string, string> = { range: 'bytes=0-0' };
  if (HF_TOKEN) headers.authorization = `Bearer ${HF_TOKEN}`;
  const response = await fetch(url, { headers });
  await response.body?.cancel();
  return Number(/\/(\d+)$/.exec(response.headers.get('content-range') ?? '')?.[1]);
}

const authorization = HF_TOKEN ? `Bearer ${HF_TOKEN}` : undefined;

async function readRemote(url: string): Promise<GgufHeader> {
  const counter = countingFetch();
  const header = await readGgufMetadata(url, { fetch: counter.fetch, authorization });
  // Only the first request goes through the Hub's redirect; later ranges go straight to the CDN.
  expect(counter.urls.filter(entry => entry === url)).toHaveLength(1);
  expect(counter.bytes).toBeLessThan(2 * header.headerBytes + 1024 * 1024);
  checkLayout(header, await remoteSize(url));
  return header;
}

describe.runIf(HF)('GGUF headers from Hugging Face', () => {
  const localQwen25 = GGUF_FILES.find(file => basename(file) === basename(HF_QWEN25));

  it.runIf(localQwen25)(
    'reads the same header over HTTPS as from the local copy',
    async () => {
      const local = await readGgufMetadata(localQwen25 ?? '');
      checkLayout(local, (await stat(localQwen25 ?? '')).size);
      expect(await readRemote(HF_QWEN25)).toEqual(local);
      expect(await inspectGguf(HF_QWEN25)).toEqual(await inspectGguf(localQwen25 ?? ''));
    },
    LIVE_TIMEOUT_MS
  );

  it.each(HF_MOE)(
    'splits %s into the expert bytes its tensor infos add up to',
    async url => {
      const header = await readRemote(url);
      const { layers, stats } = expectedStats(header.tensors);
      const inspection = await inspectGguf(url, { authorization });
      expect(inspection.tensorStats).toEqual(stats);
      expect(inspection.arch?.moe?.moeLayers).toBe(layers);
    },
    LIVE_TIMEOUT_MS
  );

  it(
    'reads every shard of a split MoE GGUF',
    async () => {
      const first = await readRemote(HF_SPLIT);
      const count = first.metadata['split.count'];
      expect(count).toBeGreaterThan(1);
      const urls = ggufShardLocations(HF_SPLIT, Number(count)) ?? [];
      const shards = [first, ...(await Promise.all(urls.slice(1).map(readRemote)))];
      const tensors = shards.flatMap(shard => shard.tensors);
      expect(tensors).toHaveLength(Number(first.metadata['split.tensors.count']));
      const { layers, stats } = expectedStats(tensors);
      const inspection = await inspectGguf(HF_SPLIT, { authorization });
      expect(inspection.tensorStats).toEqual(stats);
      expect(inspection.arch?.moe?.moeLayers).toBe(layers);
      expect(inspection.tensorStats).not.toEqual(expectedStats(first.tensors).stats);
    },
    LIVE_TIMEOUT_MS
  );

  it(
    'reads a gemma3n header, whose per-layer float array holds the infinities Ollama drops from model_info',
    async () => {
      const { metadata } = await readRemote(HF_GEMMA3N);
      const scale = metadata['gemma3n.activation_sparsity_scale'];
      expect(Array.isArray(scale) && scale.some(item => typeof item === 'number' && !Number.isFinite(item))).toBe(true);
      const { arch } = await inspectGguf(HF_GEMMA3N, { authorization });
      const kvLayers = Number(metadata['gemma3n.block_count']) - Number(metadata['gemma3n.attention.shared_kv_layers']);
      expect((arch?.full.layers ?? 0) + (arch?.swa?.layers ?? 0)).toBe(kvLayers);
    },
    LIVE_TIMEOUT_MS
  );
});
