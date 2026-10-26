// Trimmed from the live Ollama 0.31.1 captures in b4m-core/services/src/modelDiscoveryService/sources/__fixtures__/ollama.

const qwen36 = {
  name: 'qwen3.6:35b-a3b-q4_K_M',
  model: 'qwen3.6:35b-a3b-q4_K_M',
  modified_at: '2026-07-26T05:52:19.181062713Z',
  size: 23938333577,
  digest: '07d35212591fc27746f0a317c975a6d68754fb38e9053d82e25f06057af28522',
  details: {
    parent_model: '',
    format: 'gguf',
    family: 'qwen35moe',
    families: ['qwen35moe'],
    parameter_size: '36.0B',
    quantization_level: 'Q4_K_M',
    context_length: 262144,
    embedding_length: 2048,
  },
  capabilities: ['vision', 'completion', 'tools', 'thinking'],
};

const gemma4 = {
  name: 'gemma4:26b-a4b-it-q4_K_M',
  model: 'gemma4:26b-a4b-it-q4_K_M',
  modified_at: '2026-07-26T05:37:46.517490147Z',
  size: 17987581215,
  digest: '5571076f3d70050487b26b341705799e0ab29b808164f90d20d4cf84f699d251',
  details: {
    parent_model: '',
    format: 'gguf',
    family: 'gemma4',
    families: ['gemma4'],
    parameter_size: '25.8B',
    quantization_level: 'Q4_K_M',
  },
  capabilities: ['completion', 'tools', 'thinking'],
};

const qwen3Embedding = {
  name: 'qwen3-embedding:0.6b',
  model: 'qwen3-embedding:0.6b',
  modified_at: '2026-07-26T05:31:11.291023955Z',
  size: 639150858,
  digest: 'ac6da0dfba84a81fdbfbaf330198c33cd77c4cdfc53e8bc50eb581914a15621d',
  details: {
    parent_model: '',
    format: 'gguf',
    family: 'qwen3',
    families: ['qwen3'],
    parameter_size: '595.78M',
    quantization_level: 'Q8_0',
    context_length: 32768,
    embedding_length: 1024,
  },
  capabilities: ['embedding'],
};

/** A localhost daemon proxying a cloud model; the tag carries `remote_host`/`remote_model`. */
export const cloudTag = {
  name: 'gpt-oss:120b-cloud',
  model: 'gpt-oss:120b-cloud',
  remote_model: 'gpt-oss:120b',
  remote_host: 'https://ollama.com:443',
  modified_at: '2026-07-20T05:38:14.552012268Z',
  size: 384,
  digest: '569662207105a2a9ab1c4d4e2d2a4fd6e4e3a3c9b2d1e0f9a8b7c6d5e4f3a2b1',
  details: { format: '', family: '', parameter_size: '', quantization_level: '' },
  capabilities: ['completion', 'tools', 'thinking'],
};

export const tags = { models: [qwen36, gemma4, qwen3Embedding, cloudTag] };

function legacy(tag: object): Record<string, unknown> {
  const details: Record<string, unknown> = { ...(tag as { details: object }).details };
  delete details.context_length;
  const copy: Record<string, unknown> = { ...tag, details };
  delete copy.capabilities;
  return copy;
}

/** The pre-0.30 /api/tags shape: no capabilities[], no details.context_length. */
export const legacyTags = { models: [qwen36, gemma4, qwen3Embedding].map(legacy) };

export const gemma4Show = {
  details: gemma4.details,
  capabilities: ['completion', 'vision', 'tools', 'thinking'],
  modified_at: gemma4.modified_at,
  model_info: {
    'gemma4.context_length': 262144,
    'gemma4.embedding_length': 2816,
    'gemma4.vision.embedding_length': 1152,
    'general.architecture': 'gemma4',
    'general.parameter_count': 25805936462,
  },
};

export const showFor = (tag: { details: object; capabilities: string[]; modified_at: string }) => ({
  details: tag.details,
  capabilities: tag.capabilities,
  modified_at: tag.modified_at,
  model_info: {},
});

export const fixtureTags = { qwen36, gemma4, qwen3Embedding };

const recurrentEveryFourth = Array.from({ length: 24 }, (_, i) => i % 4 !== 3);

/** Verbose /api/show `model_info` from Ollama 0.40.11 (identical on 0.34.0), trimmed to the architecture keys. */
export const liveModelInfo = {
  'gemma3:270m': {
    'general.architecture': 'gemma3',
    'gemma3.attention.head_count': 4,
    'gemma3.attention.head_count_kv': 1,
    'gemma3.attention.key_length': 256,
    'gemma3.attention.sliding_window': 512,
    'gemma3.attention.value_length': 256,
    'gemma3.block_count': 18,
    'gemma3.context_length': 32768,
    'gemma3.embedding_length': 640,
  },
  'qwen3.5:0.8b': {
    'general.architecture': 'qwen35',
    'qwen35.attention.head_count': 8,
    'qwen35.attention.head_count_kv': 2,
    'qwen35.attention.key_length': 256,
    'qwen35.attention.recurrent_layers': recurrentEveryFourth,
    'qwen35.attention.value_length': 256,
    'qwen35.block_count': 24,
    'qwen35.context_length': 262144,
    'qwen35.embedding_length': 1024,
    'qwen35.full_attention_interval': 4,
    'qwen35.rope.dimension_count': 64,
    'qwen35.ssm.conv_kernel': 4,
    'qwen35.ssm.group_count': 16,
    'qwen35.ssm.inner_size': 2048,
    'qwen35.ssm.state_size': 128,
    'qwen35.ssm.time_step_rank': 16,
  },
  'granite4:350m-h': {
    'general.architecture': 'granitehybrid',
    'granitehybrid.attention.head_count': 12,
    'granitehybrid.attention.head_count_kv': Array.from({ length: 32 }, (_, i) =>
      [10, 13, 17, 27].includes(i) ? 4 : 0
    ),
    'granitehybrid.block_count': 32,
    'granitehybrid.context_length': 1048576,
    'granitehybrid.embedding_length': 768,
    'granitehybrid.expert_count': 0,
    'granitehybrid.expert_used_count': 0,
    'granitehybrid.rope.dimension_count': 64,
    'granitehybrid.ssm.conv_kernel': 4,
    'granitehybrid.ssm.group_count': 1,
    'granitehybrid.ssm.inner_size': 1536,
    'granitehybrid.ssm.state_size': 128,
    'granitehybrid.ssm.time_step_rank': 48,
  },
  'qwen2.5:0.5b': {
    'general.architecture': 'qwen2',
    'qwen2.attention.head_count': 14,
    'qwen2.attention.head_count_kv': 2,
    'qwen2.block_count': 24,
    'qwen2.context_length': 32768,
    'qwen2.embedding_length': 896,
  },
};

/**
 * What llama.cpp b11889 allocates for the models above (its `llama_kv_cache` and `llama_memory_recurrent` load
 * lines): e.g. gemma3 caches 3 full layers at 8192 cells and 15 sliding ones at 1024, granite 21.57 MiB of state.
 */
export const liveArch = {
  'gemma3:270m': {
    contextMax: 32768,
    blockCount: 18,
    full: { layers: 3, kvHeads: 1, keyLength: 256, valueLength: 256 },
    swa: { layers: 15, kvHeads: 1, keyLength: 256, valueLength: 256, window: 512 },
    mtpLayers: 0,
  },
  'qwen3.5:0.8b': {
    contextMax: 262144,
    blockCount: 24,
    full: { layers: 6, kvHeads: 2, keyLength: 256, valueLength: 256 },
    recurrent: { layers: 18, stateBytesPerSeq: 20201472 },
    mtpLayers: 0,
  },
  'granite4:350m-h': {
    contextMax: 1048576,
    blockCount: 32,
    full: { layers: 4, kvHeads: 4, keyLength: 64, valueLength: 64 },
    recurrent: { layers: 28, stateBytesPerSeq: 22622208 },
    mtpLayers: 0,
  },
  'qwen2.5:0.5b': {
    contextMax: 32768,
    blockCount: 24,
    full: { layers: 24, kvHeads: 2, keyLength: 64, valueLength: 64 },
    mtpLayers: 0,
  },
};
