import { describe, expect, it } from 'vitest';
import { isAbliteratedModel, licenseKind } from './models';

describe('licenseKind', () => {
  it('is permissive only when every declared license is', () => {
    expect(licenseKind(['apache-2.0'])).toBe('permissive');
    expect(licenseKind(['MIT', 'bsd-3-clause'])).toBe('permissive');
    expect(licenseKind(['apache-2.0', 'gemma'])).toBe('restricted');
    expect(licenseKind(['apache-2.0', 'llama3'])).toBe('restricted');
    expect(licenseKind(['other'])).toBe('restricted');
    expect(licenseKind([])).toBe('restricted');
  });
});

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
  ])('flags %s', id => {
    expect(isAbliteratedModel(id, ['gguf'])).toBe(true);
  });

  it('reads tags and base models, and only whole-word markers', () => {
    expect(isAbliteratedModel('someone/Plain-GGUF', ['gguf'], ['huihui-ai/Qwen3-8B-abliterated'])).toBe(true);
    expect(isAbliteratedModel('someone/Plain-GGUF', ['heretic'])).toBe(true);
    expect(isAbliteratedModel('someone/Heretical-Poems-GGUF')).toBe(false);
    expect(isAbliteratedModel('Qwen/Qwen2.5-0.5B-Instruct-GGUF', ['gguf'], ['Qwen/Qwen2.5-0.5B-Instruct'])).toBe(false);
  });
});
