import { describe, expect, it } from 'vitest';
import { archFromModelInfo, tensorStatsFromTensors } from './arch';
import { ggufModels } from './__test__/ggufFixtures';
import { gemma4Show, liveArch, liveModelInfo } from './__test__/ollamaFixtures';

const qwen3 = {
  'general.architecture': 'qwen3',
  'qwen3.block_count': 36,
  'qwen3.attention.head_count': 32,
  'qwen3.attention.head_count_kv': 8,
  'qwen3.attention.key_length': 128,
  'qwen3.attention.value_length': 128,
  'qwen3.embedding_length': 4096,
  'qwen3.context_length': 40960,
};

const dense = (layers: number, kvHeads: number, keyLength: number, valueLength = keyLength) => ({
  layers,
  kvHeads,
  keyLength,
  valueLength,
});

describe('archFromModelInfo', () => {
  it.each(Object.keys(liveModelInfo) as (keyof typeof liveModelInfo)[])(
    'matches what llama.cpp allocates for %s',
    model => {
      expect(archFromModelInfo(liveModelInfo[model])).toEqual(liveArch[model]);
    }
  );

  it.each(Object.keys(ggufModels) as (keyof typeof ggufModels)[])(
    'matches what llama.cpp allocates for the real %s header',
    model => {
      const fixture: { modelInfo: Record<string, unknown>; tensors?: readonly object[]; arch: object } =
        ggufModels[model];
      expect(archFromModelInfo(fixture.modelInfo, fixture.tensors)).toEqual(fixture.arch);
    }
  );

  it('falls back to feed_forward_length for nemotron_h_moe MoE layers without a tensor list', () => {
    const { modelInfo, arch } = ggufModels['nemotron-3-nano-30b-a3b'];
    expect(archFromModelInfo(modelInfo)).toEqual(arch);
  });

  it('counts kimi-linear MoE layers from leading_dense_block_count without a tensor list', () => {
    const { modelInfo, arch } = ggufModels['kimi-linear-48b-a3b'];
    expect(archFromModelInfo(modelInfo)).toEqual(arch);
  });

  it('sizes MiniMax-01 lightning-attention state as key_length^2 per head', () => {
    const info = {
      'general.architecture': 'minimax-01',
      'minimax-01.block_count': 4,
      'minimax-01.context_length': 65536,
      'minimax-01.attention.head_count': 8,
      'minimax-01.attention.head_count_kv': [0, 8, 0, 8],
      'minimax-01.attention.key_length': 64,
      'minimax-01.attention.value_length': 64,
      'minimax-01.embedding_length': 512,
      'minimax-01.full_attention_interval': 2,
    };
    expect(archFromModelInfo(info)).toMatchObject({
      full: dense(2, 8, 64),
      recurrent: { layers: 2, stateBytesPerSeq: 2 * 64 * 64 * 8 * 4 },
    });
  });

  const hybridInfo = (architecture: string): Record<string, unknown> => ({
    'general.architecture': architecture,
    [`${architecture}.block_count`]: 80,
    [`${architecture}.context_length`]: 65536,
    [`${architecture}.attention.head_count`]: 16,
    [`${architecture}.attention.head_count_kv`]: 8,
    [`${architecture}.attention.key_length`]: 64,
    [`${architecture}.attention.value_length`]: 64,
    [`${architecture}.embedding_length`]: 1024,
    [`${architecture}.ssm.conv_kernel`]: 4,
    [`${architecture}.ssm.inner_size`]: 512,
    [`${architecture}.ssm.state_size`]: 64,
    [`${architecture}.ssm.group_count`]: 2,
  });

  it('defaults minimax-01 to a full-attention interval of 8', () => {
    const info = hybridInfo('minimax-01');
    const arch = archFromModelInfo(info);
    expect(arch?.full.layers).toBe(10);
    expect(arch?.recurrent?.layers).toBe(70);
    expect(archFromModelInfo({ ...info, 'minimax-01.full_attention_interval': 4 })?.full.layers).toBe(20);
  });

  it('returns null for qwen4exp, whose PLE and indexer caches are not modeled', () => {
    expect(archFromModelInfo(hybridInfo('qwen4exp'))).toBeNull();
  });

  it('reads a dense model from the architecture-prefixed keys', () => {
    expect(archFromModelInfo(qwen3)).toEqual({
      contextMax: 40960,
      blockCount: 36,
      headCount: 32,
      embeddingLength: 4096,
      full: dense(36, 8, 128),
      mtpLayers: 0,
    });
  });

  it('omits the active FFN width when an MoE header lacks an expert width', () => {
    const moe = {
      ...qwen3,
      'qwen3.feed_forward_length': 12288,
      'qwen3.expert_count': 128,
      'qwen3.expert_used_count': 8,
    };
    expect(archFromModelInfo(moe)?.activeFeedForwardLength).toBeUndefined();
    expect(archFromModelInfo({ ...moe, 'qwen3.expert_feed_forward_length': 768 })?.activeFeedForwardLength).toBe(
      8 * 768
    );
  });

  it('derives the head dim from embedding_length / head_count when key_length is absent', () => {
    expect(archFromModelInfo(liveModelInfo['qwen2.5:0.5b'])?.full).toEqual(dense(24, 2, 64));
  });

  it('reads a scalar head_count from the real qwen2.5 header', () => {
    expect(archFromModelInfo(liveModelInfo['qwen2.5:0.5b'])?.headCount).toBe(14);
  });

  it('takes the widest layer of a per-layer head_count, ignoring the zeros of recurrent layers', () => {
    const { modelInfo } = ggufModels['jamba-reasoning-3b'];
    const heads = modelInfo['jamba.attention.head_count_kv'].map(kv => (kv > 0 ? 20 : 0));
    const info = { ...modelInfo, 'jamba.attention.head_count': heads, 'jamba.attention.key_length': undefined };
    expect(archFromModelInfo(info)?.headCount).toBe(20);
  });

  it('omits headCount when head_count is missing or all zero', () => {
    expect(archFromModelInfo({ ...qwen3, 'qwen3.attention.head_count': undefined })).not.toHaveProperty('headCount');
    expect(archFromModelInfo(ggufModels['rwkv-6-world-7b'].modelInfo)).not.toHaveProperty('headCount');
  });

  it('treats a missing head_count_kv as multi-head attention', () => {
    expect(archFromModelInfo({ ...qwen3, 'qwen3.attention.head_count_kv': undefined })?.full).toEqual(
      dense(36, 32, 128)
    );
  });

  it('returns null when a required field is missing', () => {
    expect(archFromModelInfo(gemma4Show.model_info)).toBeNull();
    expect(archFromModelInfo({ ...qwen3, 'qwen3.block_count': undefined })).toBeNull();
    expect(archFromModelInfo({ ...qwen3, 'general.architecture': undefined })).toBeNull();
    expect(
      archFromModelInfo({ ...qwen3, 'qwen3.attention.key_length': undefined, 'qwen3.attention.head_count': undefined })
    ).toBeNull();
    expect(archFromModelInfo(null)).toBeNull();
  });

  it.each([[[]], [null], [[4, 4]]])('returns null for a per-layer head_count_kv of %j', kv => {
    expect(archFromModelInfo({ ...qwen3, 'qwen3.attention.head_count_kv': kv })).toBeNull();
  });

  it('keeps layers with zero KV heads out of the cache even without recurrent state keys', () => {
    expect(
      archFromModelInfo({ ...qwen3, 'qwen3.block_count': 4, 'qwen3.attention.head_count_kv': [0, 8, 0, 8] })
    ).toEqual({
      contextMax: 40960,
      blockCount: 4,
      headCount: 32,
      embeddingLength: 4096,
      full: dense(2, 8, 128),
      mtpLayers: 0,
    });
  });

  it.each([[undefined], [null], [[]]])('falls back to full_attention_interval when recurrent_layers is %j', flags => {
    const info = { ...liveModelInfo['qwen3.5:0.8b'], 'qwen35.attention.recurrent_layers': flags };
    expect(archFromModelInfo(info)).toEqual(liveArch['qwen3.5:0.8b']);
  });

  it.each(['qwen35', 'qwen35moe', 'qwen3next', 'clef'])('uses the optional interval default for %s', architecture => {
    const info = Object.fromEntries(
      Object.entries(liveModelInfo['qwen3.5:0.8b']).map(([key, value]) => [
        key.replace('qwen35.', `${architecture}.`),
        key === 'general.architecture' ? architecture : value,
      ])
    );
    delete info[`${architecture}.attention.recurrent_layers`];
    delete info[`${architecture}.full_attention_interval`];
    expect(archFromModelInfo(info)).toEqual(liveArch['qwen3.5:0.8b']);
    expect(archFromModelInfo({ ...info, [`${architecture}.full_attention_interval`]: 3 })?.full.layers).toBe(8);
  });

  it.each([true, false])('applies a scalar recurrent flag of %s to every layer', recurrent => {
    const info = { ...liveModelInfo['qwen3.5:0.8b'], 'qwen35.attention.recurrent_layers': recurrent };
    const arch = archFromModelInfo(info);
    expect(arch?.full.layers).toBe(recurrent ? 0 : 24);
    expect(arch?.recurrent?.layers).toBe(recurrent ? 24 : undefined);
  });

  describe('sliding-window attention', () => {
    const gemma3 = liveModelInfo['gemma3:270m'];

    it.each([
      ['gemma2', 26, undefined, 13, 4096],
      ['gemma2', 26, 0, 13, 0],
      ['gemma2', 26, 1024, 13, 1024],
      ['exaone4', 64, undefined, 48, 4096],
      ['exaone4', 64, 1024, 48, 1024],
      ['exaone4', 64, 0, 48, 0],
      ['exaone4', 30, undefined, 0, undefined],
      ['exaone4', 30, 1024, 0, undefined],
      ['llama4', 48, undefined, 36, 8192],
      ['llama4', 48, 1024, 36, 8192],
      ['llama4', 48, 0, 0, undefined],
      ['smallthinker', 32, undefined, 0, undefined],
      ['smallthinker', 32, 1024, 24, 4096],
      ['smallthinker', 32, 0, 0, undefined],
    ] as const)(
      'matches %s cache policy with %i layers and window %s',
      (architecture, blockCount, window, slidingCount, expectedWindow) => {
        const arch = archFromModelInfo({
          'general.architecture': architecture,
          [`${architecture}.block_count`]: blockCount,
          [`${architecture}.context_length`]: 32768,
          [`${architecture}.attention.head_count`]: 8,
          [`${architecture}.attention.head_count_kv`]: 4,
          [`${architecture}.attention.key_length`]: 128,
          [`${architecture}.attention.sliding_window`]: window,
        });
        expect(arch?.full.layers).toBe(blockCount - slidingCount);
        expect(arch?.swa?.layers ?? 0).toBe(slidingCount);
        expect(arch?.swa?.window).toBe(expectedWindow);
      }
    );

    it('uses llama.cpp per-architecture pattern when the GGUF has none', () => {
      const gptOss = {
        'general.architecture': 'gpt-oss',
        'gpt-oss.block_count': 24,
        'gpt-oss.context_length': 131072,
        'gpt-oss.attention.head_count': 64,
        'gpt-oss.attention.head_count_kv': 8,
        'gpt-oss.attention.key_length': 64,
        'gpt-oss.attention.value_length': 64,
        'gpt-oss.attention.sliding_window': 128,
        'gpt-oss.expert_count': 32,
        'gpt-oss.expert_used_count': 4,
      };
      expect(archFromModelInfo(gptOss)).toEqual({
        contextMax: 131072,
        blockCount: 24,
        headCount: 64,
        full: dense(12, 8, 64),
        swa: { ...dense(12, 8, 64), window: 128 },
        mtpLayers: 0,
        moe: { experts: 32, used: 4, moeLayers: 24 },
      });
    });

    it('prefers an explicit per-layer pattern, separate SWA head sizes, and stops at shared-KV layers', () => {
      const pattern = Array.from({ length: 12 }, (_, i) => i % 6 !== 5);
      const gemma4 = {
        'general.architecture': 'gemma4',
        'gemma4.block_count': 12,
        'gemma4.context_length': 131072,
        'gemma4.attention.head_count': 8,
        'gemma4.attention.head_count_kv': [2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 1],
        'gemma4.attention.key_length': 512,
        'gemma4.attention.value_length': 512,
        'gemma4.attention.key_length_swa': 256,
        'gemma4.attention.value_length_swa': 256,
        'gemma4.attention.sliding_window': 512,
        'gemma4.attention.sliding_window_pattern': pattern,
        'gemma4.attention.shared_kv_layers': 4,
      };
      expect(archFromModelInfo(gemma4)).toEqual({
        contextMax: 131072,
        blockCount: 12,
        headCount: 8,
        full: dense(1, 1, 512),
        swa: { ...dense(7, 2, 256), window: 512 },
        mtpLayers: 0,
      });
    });

    it('reads an integer pattern', () => {
      const arch = archFromModelInfo({ ...gemma3, 'gemma3.attention.sliding_window_pattern': 3 });
      expect([arch?.full.layers, arch?.swa?.layers]).toEqual([6, 12]);
    });

    it('returns null for a pattern blanked by a non-verbose /api/show', () => {
      expect(archFromModelInfo({ ...gemma3, 'gemma3.attention.sliding_window_pattern': [] })).toBeNull();
      expect(archFromModelInfo({ ...gemma3, 'gemma3.attention.sliding_window_pattern': null })).toBeNull();
    });

    it('ignores sliding_window on architectures llama.cpp runs with full attention', () => {
      const arch = archFromModelInfo({ ...qwen3, 'qwen3.attention.sliding_window': 4096 });
      expect(arch?.swa).toBeUndefined();
      expect(arch?.full.layers).toBe(36);
    });

    it('gives llama4 its default chunk unless sliding_window is 0', () => {
      const llama4 = {
        'general.architecture': 'llama4',
        'llama4.block_count': 48,
        'llama4.context_length': 10485760,
        'llama4.attention.head_count': 40,
        'llama4.attention.head_count_kv': 8,
        'llama4.attention.key_length': 128,
        'llama4.expert_count': 16,
        'llama4.expert_used_count': 1,
        'llama4.interleave_moe_layer_step': 2,
      };
      const arch = archFromModelInfo(llama4);
      expect(arch?.swa).toEqual({ ...dense(36, 8, 128), window: 8192 });
      expect(arch?.moe).toEqual({ experts: 16, used: 1, moeLayers: 24 });
      expect(archFromModelInfo({ ...llama4, 'llama4.attention.sliding_window': 0 })?.swa).toBeUndefined();
    });

    it('makes every attention layer of lfm2 sliding and prices its short-conv state', () => {
      const lfm2 = {
        'general.architecture': 'lfm2',
        'lfm2.block_count': 4,
        'lfm2.context_length': 128000,
        'lfm2.embedding_length': 1024,
        'lfm2.attention.head_count': 16,
        'lfm2.attention.head_count_kv': [0, 8, 0, 8],
        'lfm2.attention.sliding_window': 4096,
        'lfm2.shortconv.l_cache': 3,
      };
      expect(archFromModelInfo(lfm2)).toEqual({
        contextMax: 128000,
        blockCount: 4,
        headCount: 16,
        embeddingLength: 1024,
        full: dense(0, 8, 64),
        swa: { ...dense(2, 8, 64), window: 4096 },
        recurrent: { layers: 2, stateBytesPerSeq: 2 * 1024 * 2 * 4 },
        mtpLayers: 0,
      });
    });
  });

  it('prices MLA-converted DeepSeek-style models as one latent cache, skipping dense leading blocks for MoE', () => {
    const deepseek = {
      'general.architecture': 'deepseek2',
      'deepseek2.block_count': 61,
      'deepseek2.context_length': 163840,
      'deepseek2.attention.head_count': 128,
      'deepseek2.attention.head_count_kv': 1,
      'deepseek2.attention.key_length': 576,
      'deepseek2.attention.value_length': 512,
      'deepseek2.attention.key_length_mla': 192,
      'deepseek2.attention.value_length_mla': 128,
      'deepseek2.attention.kv_lora_rank': 512,
      'deepseek2.rope.dimension_count': 64,
      'deepseek2.expert_count': 256,
      'deepseek2.expert_used_count': 8,
      'deepseek2.leading_dense_block_count': 3,
      'deepseek2.nextn_predict_layers': 1,
    };
    expect(archFromModelInfo(deepseek)).toEqual({
      contextMax: 163840,
      blockCount: 61,
      headCount: 128,
      full: dense(0, 1, 576, 512),
      mla: { layers: 60, kvLoraRank: 512, ropeDim: 64 },
      mtpLayers: 1,
      moe: { experts: 256, used: 8, moeLayers: 57 },
    });
    // Pre-MLA conversions cache full per-head K/V.
    const legacy = {
      ...deepseek,
      'deepseek2.attention.key_length_mla': undefined,
      'deepseek2.attention.head_count_kv': 128,
    };
    expect(archFromModelInfo(legacy)?.full).toEqual(dense(60, 128, 576, 512));
    // DSA and MSA add an indexer key cache and an F32 score per layer that MLA pricing misses.
    for (const dsa of ['deepseek32', 'glm-dsa', 'glm5-next', 'minimax-m3']) {
      const info = Object.fromEntries(
        Object.entries(deepseek).map(([key, value]) => [key.replace(/^deepseek2\b/, dsa), value])
      );
      expect(archFromModelInfo({ ...info, 'general.architecture': dsa })).toBeNull();
    }
    expect(archFromModelInfo(legacy)?.mla).toBeUndefined();
  });

  it('returns null when nextn_predict_layers leaves no trunk', () => {
    expect(archFromModelInfo({ ...qwen3, 'qwen3.nextn_predict_layers': 36 })).toBeNull();
  });
});

describe('tensorStatsFromTensors', () => {
  const moeTensors = [
    { name: 'token_embd.weight', type: 'Q8_0', shape: [64, 1000] },
    { name: 'blk.0.attn_q.weight', type: 'F16', shape: [64, 64] },
    { name: 'blk.0.ffn_gate_exps.weight', type: 'Q4_K', shape: [256, 128, 8] },
    { name: 'blk.0.ffn_down_exps.weight', type: 'MXFP4', shape: [128, 256, 8] },
    { name: 'blk.0.ffn_gate_exps.bias', type: 'F32', shape: [128, 8] },
    { name: 'blk.0.ffn_up_shexp.weight', type: 'Q6_K', shape: [256, 128] },
    { name: 'blk.1.ffn_gate_up_exps.weight', type: 'Q4_K', shape: [256, 256, 8] },
  ];

  it('splits routed expert bytes per layer from everything else', () => {
    const embd = (64 * 1000 * 34) / 32;
    const attn = 64 * 64 * 2;
    const shared = ((256 * 128) / 256) * 210;
    const layer0 = ((256 * 128 * 8) / 256) * 144 + ((128 * 256 * 8) / 32) * 17 + 128 * 8 * 4;
    const layer1 = ((256 * 256 * 8) / 256) * 144;
    expect(tensorStatsFromTensors(moeTensors)).toEqual({
      expertBytesPerLayer: Math.round((layer0 + layer1) / 2),
      nonExpertBytes: embd + attn + shared,
    });
  });

  it('returns null for dense models, unknown tensor types, and non-verbose responses', () => {
    expect(tensorStatsFromTensors(moeTensors.filter(tensor => !tensor.name.includes('_exps')))).toBeNull();
    expect(tensorStatsFromTensors([...moeTensors, { name: 'blk.1.x.weight', type: 'Q9_Z', shape: [32] }])).toBeNull();
    expect(tensorStatsFromTensors(undefined)).toBeNull();
    expect(tensorStatsFromTensors(null)).toBeNull();
  });
});
