import { open, stat } from 'node:fs/promises';

const CHAT_TEMPLATE_KEY = 'tokenizer.chat_template';
/** Tokenizer arrays come before the template and run to a few MB; past this the header is given up on. */
const MAX_SCAN_BYTES = 64 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;
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

async function scan(path: string): Promise<string | null | undefined> {
  const handle = await open(path, 'r');
  try {
    const reader = new HeaderReader(handle);
    if ((await reader.u32()) !== 0x46554747) return undefined;
    const version = await reader.u32();
    if (version !== 2 && version !== 3) return undefined;
    await reader.u64();
    const pairs = await reader.u64();
    for (let i = 0; i < pairs; i++) {
      const key = await reader.string();
      const type = await reader.u32();
      if (key === CHAT_TEMPLATE_KEY && type === GGUF_STRING) return await reader.string();
      await reader.skipValue(type);
    }
    return null;
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

const cache = new Map<string, string | null | undefined>();

/**
 * The `tokenizer.chat_template` in a GGUF file's header: null when the header has none, undefined when it could
 * not be read (not GGUF v2/v3, truncated, or past the scan cap). Cached by path, mtime and size.
 */
export async function readGgufChatTemplate(path: string): Promise<string | null | undefined> {
  const info = await stat(path).catch(() => null);
  if (!info) return undefined;
  const key = `${path}\0${info.mtimeMs}\0${info.size}`;
  if (cache.has(key)) return cache.get(key);
  const template = await scan(path).catch(() => undefined);
  cache.set(key, template);
  return template;
}

/**
 * Tool and thinking support as the chat template shows it. A template that never mentions `tools` cannot render
 * them; an unreadable header reports tools as supported, since llama-server runs with `--jinja` either way.
 */
export function templateCapabilities(template: string | null | undefined): { tools: boolean; thinking: boolean } {
  if (template === undefined) return { tools: true, thinking: false };
  if (template === null) return { tools: false, thinking: false };
  return { tools: /\btools\b/.test(template), thinking: /<think>|enable_thinking/.test(template) };
}
