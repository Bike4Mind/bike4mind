import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageModels, ModelBackend, type ModelInfo } from '@bike4mind/common';

// Ollama is the one backend in the apiKeys=null fan-out that would do a network
// call. The fake echoes its host into the model id so a cache key that collapses
// two different Ollama URLs shows up as the wrong list rather than as a hang.
const ollamaHosts: string[] = [];
let ollamaListing: (host: string) => Promise<ModelInfo[]> = async host => [
  { id: `ollama@${host}`, type: 'text', name: host, backend: ModelBackend.Ollama } as ModelInfo,
];

vi.mock('./ollamaBackend', () => ({
  OllamaBackend: class {
    constructor(private readonly host: string) {
      ollamaHosts.push(host);
    }
    getModelInfo() {
      return ollamaListing(this.host);
    }
  },
}));

const { getAvailableModels, setModelPriceRowsProvider } = await import('./index');

// A private model from the always-constructed BFL listing: the includePrivate
// contract is observable with no keys and no network.
const PRIVATE_MODEL = ImageModels.FLUX_PRO_FILL;

const savedSelfHost = process.env.B4M_SELF_HOST;

beforeEach(() => {
  ollamaHosts.length = 0;
  ollamaListing = async host => [
    { id: `ollama@${host}`, type: 'text', name: host, backend: ModelBackend.Ollama } as ModelInfo,
  ];
  // Also resets the module-level model cache, so each case re-runs the fan-out.
  setModelPriceRowsProvider(null);
  delete process.env.B4M_SELF_HOST;
});

afterEach(() => {
  setModelPriceRowsProvider(null);
  if (savedSelfHost === undefined) delete process.env.B4M_SELF_HOST;
  else process.env.B4M_SELF_HOST = savedSelfHost;
});

describe('getAvailableModels options', () => {
  it('includes private models by default, as the settlement and agent consumers require', async () => {
    const models = await getAvailableModels(null);
    expect(models.some(m => m.id === PRIVATE_MODEL)).toBe(true);
  });

  it('omits private models when includePrivate is false', async () => {
    const models = await getAvailableModels(null, { includePrivate: false });
    expect(models.some(m => m.id === PRIVATE_MODEL)).toBe(false);
    expect(models.every(m => !m.private)).toBe(true);
  });

  it('lists the AWS-credentialed backends by default and withholds them under self-host', async () => {
    const hosted = await getAvailableModels(null, { isSelfHost: false });
    expect(hosted.some(m => m.backend === ModelBackend.Bedrock)).toBe(true);
    expect(hosted.some(m => m.backend === ModelBackend.AWS)).toBe(true);

    const selfHost = await getAvailableModels(null, { isSelfHost: true });
    expect(selfHost.some(m => m.backend === ModelBackend.Bedrock)).toBe(false);
    expect(selfHost.some(m => m.backend === ModelBackend.AWS)).toBe(false);
  });

  it('defaults isSelfHost to B4M_SELF_HOST', async () => {
    process.env.B4M_SELF_HOST = 'true';
    const models = await getAvailableModels(null);
    expect(models.some(m => m.backend === ModelBackend.Bedrock)).toBe(false);
  });

  it('degrades a backend that misses perBackendTimeoutMs instead of hanging the call', async () => {
    ollamaListing = () => new Promise<ModelInfo[]>(() => {});

    const models = await getAvailableModels({ ollama: 'http://slow:11434' }, { perBackendTimeoutMs: 20 });

    expect(models.some(m => m.backend === ModelBackend.Ollama)).toBe(false);
    // The rest of the fan-out still contributed; the timeout is per backend.
    expect(models.some(m => m.backend === ModelBackend.Bedrock)).toBe(true);
  });

  it('waits for a slow backend when no timeout is set', async () => {
    ollamaListing = async host => {
      await new Promise(resolve => setTimeout(resolve, 30));
      return [{ id: `ollama@${host}`, type: 'text', name: host, backend: ModelBackend.Ollama } as ModelInfo];
    };

    const models = await getAvailableModels({ ollama: 'http://slow:11434' });
    expect(models.some(m => m.id === 'ollama@http://slow:11434')).toBe(true);
  });
});

describe('getAvailableModels module cache', () => {
  it('does not serve an includePrivate:false list to an includePrivate:true caller, or the reverse', async () => {
    const filteredFirst = await getAvailableModels(null, { includePrivate: false });
    expect(filteredFirst.some(m => m.id === PRIVATE_MODEL)).toBe(false);

    // Same cache entry, opposite view: the private model must come back.
    const full = await getAvailableModels(null);
    expect(full.some(m => m.id === PRIVATE_MODEL)).toBe(true);

    const filteredAgain = await getAvailableModels(null, { includePrivate: false });
    expect(filteredAgain.some(m => m.id === PRIVATE_MODEL)).toBe(false);
  });

  it('reuses one cache entry across the two includePrivate views, rather than rebuilding per view', async () => {
    await getAvailableModels({ ollama: 'http://a:11434' });
    await getAvailableModels({ ollama: 'http://a:11434' }, { includePrivate: false });

    expect(ollamaHosts).toEqual(['http://a:11434']);
  });

  it('gives two callers with different Ollama base URLs different lists', async () => {
    const a = await getAvailableModels({ ollama: 'http://a:11434' });
    const b = await getAvailableModels({ ollama: 'http://b:11434' });

    expect(a.some(m => m.id === 'ollama@http://a:11434')).toBe(true);
    expect(b.some(m => m.id === 'ollama@http://b:11434')).toBe(true);
    expect(b.some(m => m.id === 'ollama@http://a:11434')).toBe(false);
  });

  it('separates self-host and hosted callers, which construct different backend sets', async () => {
    const hosted = await getAvailableModels(null, { isSelfHost: false });
    const selfHost = await getAvailableModels(null, { isSelfHost: true });

    expect(hosted.some(m => m.backend === ModelBackend.Bedrock)).toBe(true);
    expect(selfHost.some(m => m.backend === ModelBackend.Bedrock)).toBe(false);
  });

  it('separates a timed-out caller from an unbounded one, so a degraded list is not reused', async () => {
    ollamaListing = () => new Promise<ModelInfo[]>(() => {});
    const degraded = await getAvailableModels({ ollama: 'http://slow:11434' }, { perBackendTimeoutMs: 20 });
    expect(degraded.some(m => m.backend === ModelBackend.Ollama)).toBe(false);

    ollamaListing = async host => [
      { id: `ollama@${host}`, type: 'text', name: host, backend: ModelBackend.Ollama } as ModelInfo,
    ];
    const unbounded = await getAvailableModels({ ollama: 'http://slow:11434' });
    expect(unbounded.some(m => m.id === 'ollama@http://slow:11434')).toBe(true);
  });
});
