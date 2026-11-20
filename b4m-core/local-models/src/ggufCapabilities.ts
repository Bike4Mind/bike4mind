import { stat } from 'node:fs/promises';
import { readGgufMetadata, type GgufHeader } from './gguf';

export interface GgufCapabilityInfo {
  /** `tokenizer.chat_template`, or null when the header has none. */
  chatTemplate: string | null;
  architecture: string | null;
  /** `<architecture>.pooling_type`: 0 none, 1 mean, 2 cls, 3 last, 4 rank; null when absent. */
  poolingType: number | null;
}

/** Undefined for a header llama.cpp refuses: one with an array of arrays, even an empty one. */
function capabilityInfo({ metadata, types }: GgufHeader): GgufCapabilityInfo | undefined {
  if (Object.values(types).some(type => type.itemType === 'array')) return undefined;
  const info: GgufCapabilityInfo = { chatTemplate: null, architecture: null, poolingType: null };
  for (const [key, { type }] of Object.entries(types)) {
    const value = metadata[key];
    if (key === 'general.architecture' && typeof value === 'string') info.architecture = value;
    else if (key.endsWith('.pooling_type') && (type === 'uint32' || type === 'int32') && typeof value === 'number') {
      info.poolingType = value;
    } else if (key === 'tokenizer.chat_template' && typeof value === 'string') {
      // Converters write the tokenizer keys last, after the architecture's own keys.
      info.chatTemplate = value;
      break;
    }
  }
  return info;
}

const cache = new Map<string, GgufCapabilityInfo | undefined>();

/**
 * The chat template, architecture and pooling type in a GGUF file's header, read with `readGgufMetadata`; undefined
 * when it could not be read or llama.cpp would refuse it. Cached by path, mtime and size.
 */
export async function readCapabilityInfo(path: string): Promise<GgufCapabilityInfo | undefined> {
  const stats = await stat(path).catch(() => null);
  if (!stats) return undefined;
  const key = `${path}\0${stats.mtimeMs}\0${stats.size}`;
  if (cache.has(key)) return cache.get(key);
  const info = await readGgufMetadata(path, { timeoutMs: Infinity })
    .then(capabilityInfo)
    .catch(() => undefined);
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
export function headerCapabilities(info: GgufCapabilityInfo | undefined): {
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
