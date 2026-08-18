import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  defaultEmbeddingModelForEnv,
  getEmbeddingModelCost,
  OllamaEmbeddingModel,
  OpenAIEmbeddingModel,
  VoyageAIEmbeddingModel,
} from './embedding';

describe('getEmbeddingModelCost', () => {
  it('prices a known OpenAI model at its per-token rate', () => {
    // text-embedding-3-small is $0.02 / 1M tokens.
    expect(getEmbeddingModelCost(OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL, 1_000_000)).toBeCloseTo(0.02, 10);
    expect(getEmbeddingModelCost(OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL, 0)).toBe(0);
  });

  it('prices a known Voyage model', () => {
    expect(getEmbeddingModelCost(VoyageAIEmbeddingModel.VOYAGE_3, 1_000_000)).toBeCloseTo(0.06, 10);
  });

  it('settles $0 and alarms for an unpriced model with real usage', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(getEmbeddingModelCost('made-up-embedding-model', 500)).toBe(0);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('UNPRICED_EMBEDDING_MODEL'));
    spy.mockRestore();
  });

  it('does not alarm for an unpriced model with zero usage', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(getEmbeddingModelCost('made-up-embedding-model', 0)).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('prices local Ollama embedders at $0 without alarming', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(getEmbeddingModelCost(OllamaEmbeddingModel.NOMIC_EMBED_TEXT, 1_000_000)).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('defaultEmbeddingModelForEnv', () => {
  const saved = {
    B4M_SELF_HOST: process.env.B4M_SELF_HOST,
    OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    VOYAGE_API_KEY: process.env.VOYAGE_API_KEY,
  };
  beforeEach(() => {
    delete process.env.B4M_SELF_HOST;
    delete process.env.OLLAMA_BASE_URL;
    delete process.env.OPENAI_API_KEY;
    delete process.env.VOYAGE_API_KEY;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('returns the cloud default on hosted (B4M_SELF_HOST unset)', () => {
    process.env.OLLAMA_BASE_URL = 'http://ollama:11434';
    expect(defaultEmbeddingModelForEnv()).toBe(OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002);
  });

  it('returns a local embedder on keyless self-host with Ollama', () => {
    process.env.B4M_SELF_HOST = 'true';
    process.env.OLLAMA_BASE_URL = 'http://ollama:11434';
    expect(defaultEmbeddingModelForEnv()).toBe(OllamaEmbeddingModel.QWEN3_EMBEDDING_0_6B);
  });

  it('keeps the cloud default on self-host when an OpenAI key is set', () => {
    process.env.B4M_SELF_HOST = 'true';
    process.env.OLLAMA_BASE_URL = 'http://ollama:11434';
    process.env.OPENAI_API_KEY = 'sk-test';
    expect(defaultEmbeddingModelForEnv()).toBe(OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002);
  });

  it('keeps the cloud default on self-host when no Ollama URL is configured', () => {
    process.env.B4M_SELF_HOST = 'true';
    expect(defaultEmbeddingModelForEnv()).toBe(OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002);
  });

  it('keeps the cloud default on self-host when a VoyageAI key is set (aligned with serverConfig)', () => {
    process.env.B4M_SELF_HOST = 'true';
    process.env.OLLAMA_BASE_URL = 'http://ollama:11434';
    process.env.VOYAGE_API_KEY = 'pa-test';
    expect(defaultEmbeddingModelForEnv()).toBe(OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002);
  });

  it('treats a whitespace-only Ollama URL as unconfigured (cloud default)', () => {
    process.env.B4M_SELF_HOST = 'true';
    process.env.OLLAMA_BASE_URL = '   ';
    expect(defaultEmbeddingModelForEnv()).toBe(OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002);
  });

  it('ignores a whitespace-only cloud key and still resolves the local embedder', () => {
    process.env.B4M_SELF_HOST = 'true';
    process.env.OLLAMA_BASE_URL = 'http://ollama:11434';
    process.env.OPENAI_API_KEY = '   ';
    process.env.VOYAGE_API_KEY = '   ';
    expect(defaultEmbeddingModelForEnv()).toBe(OllamaEmbeddingModel.QWEN3_EMBEDDING_0_6B);
  });

  it('ignores a placeholder OPENAI_API_KEY and falls back to the local embedder', () => {
    // The airgapped-self-host bug: a dummy OPENAI_API_KEY used to count as a real cloud key,
    // silently picking the OpenAI default (which then 401s) instead of the local Ollama embedder.
    process.env.B4M_SELF_HOST = 'true';
    process.env.OLLAMA_BASE_URL = 'http://ollama:11434';
    process.env.OPENAI_API_KEY = 'sk-oai-dummy-routing-test';
    expect(defaultEmbeddingModelForEnv()).toBe(OllamaEmbeddingModel.QWEN3_EMBEDDING_0_6B);
  });

  it('ignores a placeholder VOYAGE_API_KEY and falls back to the local embedder', () => {
    process.env.B4M_SELF_HOST = 'true';
    process.env.OLLAMA_BASE_URL = 'http://ollama:11434';
    process.env.VOYAGE_API_KEY = 'your-api-key';
    expect(defaultEmbeddingModelForEnv()).toBe(OllamaEmbeddingModel.QWEN3_EMBEDDING_0_6B);
  });

  it('keeps the cloud default for a real key (never mistaken for a placeholder)', () => {
    // A real key must never be mistaken for a placeholder - it keeps the configured cloud default.
    // Synthetic low-entropy value on purpose (no real-key marker) to avoid push-protection flags.
    process.env.B4M_SELF_HOST = 'true';
    process.env.OLLAMA_BASE_URL = 'http://ollama:11434';
    process.env.OPENAI_API_KEY = 'sk-proj-0000aaaa1111bbbb2222cccc3333';
    expect(defaultEmbeddingModelForEnv()).toBe(OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002);
  });

  it('only exactly "true" enables self-host (a "1" value keeps the cloud default)', () => {
    process.env.B4M_SELF_HOST = '1';
    process.env.OLLAMA_BASE_URL = 'http://ollama:11434';
    expect(defaultEmbeddingModelForEnv()).toBe(OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002);
  });
});
