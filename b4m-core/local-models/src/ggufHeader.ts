import { open, stat } from 'node:fs/promises';

const CHAT_TEMPLATE_KEY = 'tokenizer.chat_template';
/** Tokenizer arrays come before the template and run to a few MB; past this the header is given up on. */
const MAX_SCAN_BYTES = 64 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;
const GGUF_U32 = 4;
const GGUF_I32 = 5;
const GGUF_STRING = 8;
const GGUF_ARRAY = 9;
const FIXED_SIZES: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };

class Unreadable extends Error {}

class HeaderReader {
  #buffer = Buffer.alloc(0);
  #base = 0;
  #pos = 0;

  constructor(private readonly handle: Awaited<ReturnType<typeof open>>) {}

  async #ensure(bytes: number): Promise<void> {
    if (this.#pos + bytes <= this.#buffer.length) return;
    if (this.#base + this.#pos + bytes > MAX_SCAN_BYTES) throw new Unreadable();
    const kept = this.#buffer.subarray(this.#pos);
    this.#base += this.#pos;
    this.#pos = 0;
    const more = Buffer.alloc(Math.max(CHUNK_BYTES, bytes - kept.length));
    const { bytesRead } = await this.handle.read(more, 0, more.length, this.#base + kept.length);
    this.#buffer = Buffer.concat([kept, more.subarray(0, bytesRead)]);
    if (this.#buffer.length < bytes) throw new Unreadable();
  }

  async u32(): Promise<number> {
    await this.#ensure(4);
    const value = this.#buffer.readUInt32LE(this.#pos);
    this.#pos += 4;
    return value;
  }

  async u64(): Promise<number> {
    await this.#ensure(8);
    const value = this.#buffer.readBigUInt64LE(this.#pos);
    this.#pos += 8;
    if (value > BigInt(MAX_SCAN_BYTES)) throw new Unreadable();
    return Number(value);
  }

  async skip(bytes: number): Promise<void> {
    const target = this.#base + this.#pos + bytes;
    if (target > MAX_SCAN_BYTES) throw new Unreadable();
    if (this.#pos + bytes <= this.#buffer.length) this.#pos += bytes;
    else {
      this.#base = target;
      this.#buffer = Buffer.alloc(0);
      this.#pos = 0;
    }
  }

  async string(): Promise<string> {
    const length = await this.u64();
    await this.#ensure(length);
    const value = this.#buffer.toString('utf8', this.#pos, this.#pos + length);
    this.#pos += length;
    return value;
  }

  async skipValue(type: number): Promise<void> {
    const fixed = FIXED_SIZES[type];
    if (fixed !== undefined) return this.skip(fixed);
    if (type === GGUF_STRING) return this.skip(await this.u64());
    if (type !== GGUF_ARRAY) throw new Unreadable();
    const itemType = await this.u32();
    // llama.cpp refuses arrays of arrays; nesting them costs one pending frame per level here.
    if (itemType === GGUF_ARRAY) throw new Unreadable();
    const count = await this.u64();
    const itemSize = FIXED_SIZES[itemType];
    if (itemSize !== undefined) return this.skip(itemSize * count);
    for (let i = 0; i < count; i++) {
      if (itemType === GGUF_STRING) i += this.#skipBufferedStrings(count - i);
      if (i < count) await this.skipValue(itemType);
    }
  }

  /** Skips up to `limit` strings already in the buffer without awaiting; a vocabulary has 100k or more. */
  #skipBufferedStrings(limit: number): number {
    let skipped = 0;
    while (skipped < limit && this.#pos + 8 <= this.#buffer.length) {
      const end = this.#pos + 8 + Number(this.#buffer.readBigUInt64LE(this.#pos));
      if (end > this.#buffer.length) break;
      this.#pos = end;
      skipped++;
    }
    return skipped;
  }
}

export interface GgufHeaderInfo {
  /** `tokenizer.chat_template`, or null when the header has none. */
  chatTemplate: string | null;
  architecture: string | null;
  /** `<architecture>.pooling_type`: 0 none, 1 mean, 2 cls, 3 last, 4 rank; null when absent. */
  poolingType: number | null;
}

async function scan(path: string): Promise<GgufHeaderInfo | undefined> {
  const handle = await open(path, 'r');
  try {
    const reader = new HeaderReader(handle);
    if ((await reader.u32()) !== 0x46554747) return undefined;
    const version = await reader.u32();
    if (version !== 2 && version !== 3) return undefined;
    await reader.u64();
    const pairs = await reader.u64();
    const info: GgufHeaderInfo = { chatTemplate: null, architecture: null, poolingType: null };
    for (let i = 0; i < pairs; i++) {
      const key = await reader.string();
      const type = await reader.u32();
      if (key === 'general.architecture' && type === GGUF_STRING) info.architecture = await reader.string();
      else if (key.endsWith('.pooling_type') && (type === GGUF_U32 || type === GGUF_I32)) {
        const value = await reader.u32();
        info.poolingType = type === GGUF_I32 ? value | 0 : value;
      } else if (key === CHAT_TEMPLATE_KEY && type === GGUF_STRING) {
        // Converters write the tokenizer keys last, after the architecture's own keys.
        info.chatTemplate = await reader.string();
        return info;
      } else await reader.skipValue(type);
    }
    return info;
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

const cache = new Map<string, GgufHeaderInfo | undefined>();

/**
 * The chat template, architecture and pooling type in a GGUF file's header; undefined when it could not be read
 * (not GGUF v2/v3, truncated, or past the scan cap). Cached by path, mtime and size.
 */
export async function readGgufHeader(path: string): Promise<GgufHeaderInfo | undefined> {
  const stats = await stat(path).catch(() => null);
  if (!stats) return undefined;
  const key = `${path}\0${stats.mtimeMs}\0${stats.size}`;
  if (cache.has(key)) return cache.get(key);
  const info = await scan(path).catch(() => undefined);
  cache.set(key, info);
  return info;
}

const ENCODER_ARCHITECTURES = new Set([
  'bert',
  'nomic-bert',
  'nomic-bert-moe',
  'jina-bert-v2',
  'modern-bert',
  't5encoder',
]);
/** Qwen-style `<think>`, gpt-oss's analysis channel and `reasoning_effort`, Magistral's `[THINK]`. */
const THINKING_RE = /<think>|enable_thinking|reasoning_effort|<\|channel\|>analysis|\[THINK\]/;

/** What a model can do as its header shows it; an unreadable header reports a chat model with tools. */
export function headerCapabilities(info: GgufHeaderInfo | undefined): {
  tools: boolean;
  thinking: boolean;
  embeddings: boolean;
  completion: boolean;
} {
  if (info === undefined) return { tools: true, thinking: false, embeddings: false, completion: true };
  if (info.architecture === 'clip') return { tools: false, thinking: false, embeddings: false, completion: false };
  const embeddings =
    (info.poolingType !== null && info.poolingType > 0) || ENCODER_ARCHITECTURES.has(info.architecture ?? '');
  if (embeddings) return { tools: false, thinking: false, embeddings: true, completion: false };
  const template = info.chatTemplate;
  return {
    tools: template !== null && /\btools\b/.test(template),
    thinking: template !== null && THINKING_RE.test(template),
    embeddings: false,
    completion: true,
  };
}
