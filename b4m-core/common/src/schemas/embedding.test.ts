import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  defaultEmbeddingModelForEnv,
  getEmbeddingModelCost,
  hasKeylessCloudEmbedder,
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
    // hasKeylessCloudEmbedder reads these: the test runner itself holds no AWS role, so each
    // case has to state the runtime it means rather than inherit the harness's.
    AWS_LAMBDA_FUNCTION_NAME: process.env.AWS_LAMBDA_FUNCTION_NAME,
    AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI,
    AWS_CONTAINER_CREDENTIALS_FULL_URI: process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI,
    SST_RESOURCE_App: process.env.SST_RESOURCE_App,
  };
  beforeEach(() => {
    for (const k of Object.keys(saved)) delete process.env[k];
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('returns the cloud default on hosted with a real key, ignoring OLLAMA_BASE_URL', () => {
    process.env.OLLAMA_BASE_URL = 'http://ollama:11434';
    process.env.OPENAI_API_KEY = 'sk-proj-0000aaaa1111bbbb2222cccc3333';
    expect(defaultEmbeddingModelForEnv()).toBe(OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002);
  });

  it('keeps the cloud default on a hosted stage with no cloud embedding key in the env', () => {
    // NOT a keyless signal: on every hosted stage an SST secret arrives as a linked Resource, so
    // OPENAI_API_KEY is absent from process.env on production exactly as it is on a preview
    // (verified against the deployed vectorize subscriber on both). Branching to Bedrock here
    // would flip the platform-wide default, so reachability is decided at the embedding seam by
    // resolveEmbeddingWithKeylessFallback, where the resolved credentials are actually known.
    expect(defaultEmbeddingModelForEnv()).toBe(OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002);
  });

  it('is stage-neutral with no env at all, so the browser bundle agrees with the server', () => {
    // settingsMap bundles this default into the client, where only NEXT_PUBLIC_* is inlined and
    // every read below is undefined. A cloud-only arm here would make useEmbeddingMismatchStatus
    // flag every ada-002 file until the settings query resolves - on keyed production too.
    for (const k of ['OPENAI_API_KEY', 'VOYAGE_API_KEY', 'B4M_SELF_HOST', 'OLLAMA_BASE_URL']) {
      delete process.env[k];
    }
    expect(defaultEmbeddingModelForEnv()).toBe(OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002);
  });

  it('reports Bedrock reachable on cloud and unreachable on self-host', () => {
    // hasKeylessCloudEmbedder answers "can Bedrock be reached", not "should it be used" - a keyed
    // stage is keyless-capable too. Self-host has no AWS role, so its keyless path is Ollama.
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'some-stage-fabFileVectorize';
    expect(hasKeylessCloudEmbedder()).toBe(true);
    process.env.B4M_SELF_HOST = 'true';
    expect(hasKeylessCloudEmbedder()).toBe(false);
    expect(defaultEmbeddingModelForEnv()).toBe(OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002);
  });

  it('reports Bedrock reachable from the Fargate chat container, not just from Lambda', () => {
    // ChatCompletion (and so knowledgeBaseSearch) is an ECS service, which carries the task-role
    // URI instead of AWS_LAMBDA_FUNCTION_NAME. A Lambda-only predicate would leave chat
    // knowledge-base search failing on precisely the keyless stages the fallback is for.
    process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = '/v2/credentials/abc123';
    expect(hasKeylessCloudEmbedder()).toBe(true);
  });

  it('accepts the SST linked-resource marker, which both runtimes carry', () => {
    // The arm this repo can prove rather than infer: SST sets SST_RESOURCE_* on everything it
    // links, Function and Service alike, so it covers the Fargate task without depending on
    // which ECS credential variable AWS injects.
    process.env.SST_RESOURCE_App = '{"name":"bike4mind","stage":"pr1234"}';
    expect(hasKeylessCloudEmbedder()).toBe(true);
  });

  it('reports Bedrock unreachable in local dev and CI, which hold no AWS role', () => {
    // Neither sets B4M_SELF_HOST, so an "absence of the self-host flag" test would claim a
    // keyless Bedrock embedder here and trade the actionable missing-key message for an opaque
    // CredentialsProviderError out of the AWS SDK.
    for (const k of [
      'B4M_SELF_HOST',
      'AWS_LAMBDA_FUNCTION_NAME',
      'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
      'AWS_CONTAINER_CREDENTIALS_FULL_URI',
    ]) {
      delete process.env[k];
    }
    expect(hasKeylessCloudEmbedder()).toBe(false);
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
    // The point is that OLLAMA_BASE_URL is ignored without a literal 'true': such a deployment
    // reads as hosted and keeps the cloud default rather than reaching the local embedder.
    process.env.B4M_SELF_HOST = '1';
    process.env.OLLAMA_BASE_URL = 'http://ollama:11434';
    expect(defaultEmbeddingModelForEnv()).toBe(OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002);
  });
});
