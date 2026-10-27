import { describe, expect, it } from 'vitest';
import { isAbliteratedModel } from './abliterated';

describe('isAbliteratedModel', () => {
  // Real GGUF repos whose ids carry no "abliterat" or "uncensored".
  it.each([
    'mudler/gemma-4-26B-A4B-it-heretic-APEX-GGUF',
    'SC117/Ornith-1.0-35B-Heretic-MTP-APEX-GGUF',
    'Bucoid/Qwen3.8-27B-Heretic-Ara-16GB-VRAM-IQ4-XS-MTP-GGUF',
    'Abiray/gemma-4-E4B-it-heretic-GGUF',
    'mradermacher/qwen-2.5-3b-decensored-i1-GGUF',
    'mradermacher/Qwen3-Next-80B-A3B-Instruct-Decensored-GGUF',
    'bartowski/huihui-ai_gemma-3-1b-it-abliterated-GGUF',
    'someone/Llama-3-8B-Uncensored-GGUF',
    'someone/QwenUncensored-7B-GGUF',
    'someone/LlamaHeretic-8B-GGUF',
  ])('flags %s', id => {
    expect(isAbliteratedModel({ id, tags: ['gguf'] })).toBe(true);
  });

  it('reads tags and base models, and only whole-word markers', () => {
    expect(
      isAbliteratedModel({ id: 'someone/Plain-GGUF', tags: ['gguf'], baseModels: ['huihui-ai/Qwen3-8B-abliterated'] })
    ).toBe(true);
    expect(isAbliteratedModel({ id: 'someone/Plain-GGUF', tags: ['heretic'] })).toBe(true);
    expect(isAbliteratedModel({ id: 'someone/Heretical-Poems-GGUF' })).toBe(false);
    expect(isAbliteratedModel({ id: 'someone/TheHereticalPoems-GGUF' })).toBe(false);
    expect(
      isAbliteratedModel({
        id: 'Qwen/Qwen2.5-0.5B-Instruct-GGUF',
        tags: ['gguf'],
        baseModels: ['Qwen/Qwen2.5-0.5B-Instruct'],
      })
    ).toBe(false);
  });
});
