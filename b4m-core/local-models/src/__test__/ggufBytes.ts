// Builds GGUF v3 headers for tests: metadata only, no tensors.
const u32 = (value: number) => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
};
const u64 = (value: number) => {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value));
  return buffer;
};
const text = (value: string) => {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([u64(bytes.length), bytes]);
};

export type GgufValue =
  | { type: 'u32'; value: number }
  | { type: 'string'; value: string }
  | { type: 'strings'; value: string[] }
  | { type: 'floats'; count: number };

function encode(entry: GgufValue): Buffer {
  switch (entry.type) {
    case 'u32':
      return Buffer.concat([u32(4), u32(entry.value)]);
    case 'string':
      return Buffer.concat([u32(8), text(entry.value)]);
    case 'strings':
      return Buffer.concat([u32(9), u32(8), u64(entry.value.length), ...entry.value.map(text)]);
    case 'floats':
      return Buffer.concat([u32(9), u32(6), u64(entry.count), Buffer.alloc(entry.count * 4)]);
  }
}

export function ggufBytes(metadata: Record<string, GgufValue>, version = 3): Buffer {
  const entries = Object.entries(metadata);
  return Buffer.concat([
    Buffer.from('GGUF'),
    u32(version),
    u64(0),
    u64(entries.length),
    ...entries.map(([key, value]) => Buffer.concat([text(key), encode(value)])),
  ]);
}

/** A header with tokenizer arrays ahead of `template`, as converted models have; no template key when null. */
export function ggufWithTemplate(template: string | null): Buffer {
  return ggufBytes({
    'general.architecture': { type: 'string', value: 'qwen2' },
    'general.alignment': { type: 'u32', value: 32 },
    'tokenizer.ggml.tokens': { type: 'strings', value: ['<s>', 'hello', 'world'] },
    'tokenizer.ggml.scores': { type: 'floats', count: 3 },
    ...(template === null ? {} : { 'tokenizer.chat_template': { type: 'string' as const, value: template } }),
  });
}
