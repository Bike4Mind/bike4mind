import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EMBEDDING_MODEL_IDS,
  EMBEDDING_PROVIDER_IDS,
  getEmbeddingModelCapabilities,
  type SupportedEmbeddingModel,
} from '@bike4mind/common';
import { isEmbeddingAuthError } from '@bike4mind/fab-pipeline';
import { createEmbeddingProviderRegistry } from './registry';
import type { EmbeddingProvider } from './types';

/**
 * Deterministic stand-in for a backend's embedding of `text`: the same text and width always give the same vector,
 * distinct texts give distinct vectors, and every value survives a float32 round trip (some wire formats are
 * float32). Fake backends use it so the suite can check order without knowing how a
 * provider encodes its requests.
 */
export function fakeEmbedding(text: string, width: number): number[] {
  let seed = 2166136261;
  for (let index = 0; index < text.length; index++) {
    seed = Math.imul(seed ^ text.charCodeAt(index), 16777619) >>> 0;
  }
  return Array.from({ length: width }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return Math.fround(seed / 0xffffffff);
  });
}

/**
 * Every provider must pass this against a fake backend that embeds with `fakeEmbedding`. Test-only: never export from
 * index.ts (it imports vitest). The backend must serve each of the provider's models at every width the catalog
 * offers, and `requestCount` must count the requests that reached it.
 */
export type EmbeddingConformanceSetup = {
  provider: () => EmbeddingProvider;
  /** Total requests that reached the fake backend so far. */
  requestCount: () => number;
  scenarios: {
    /** Arms a backend that embeds every input successfully. */
    succeeds: () => void | Promise<void>;
    /** Arms a backend that rejects credentials. Omit for a provider with no credentials. */
    unauthorized?: () => void | Promise<void>;
    /**
     * Arms a backend that rejects, with a non-retryable and non-auth error, any request whose inputs include
     * `LATE_FAILURE_INPUT`, and serves the rest. The suite places it last in a large batch, so a provider that
     * sub-batches has already succeeded on earlier requests when this one fails.
     */
    failsOnLateInput: () => void | Promise<void>;
  };
  beforeEach?: () => Promise<void> | void;
  afterEach?: () => Promise<void> | void;
};

/** The last input of the suite's large batch; see `scenarios.failsOnLateInput`. */
export const LATE_FAILURE_INPUT = 'input number 69';

// Crosses Ollama's 64-input sub-batch so the suite exercises splitting.
const LARGE_BATCH_SIZE = 70;

const nonNativeWidths = (model: SupportedEmbeddingModel): number[] => {
  const { dimensions } = getEmbeddingModelCapabilities(model);
  if (dimensions.kind === 'range') return [dimensions.min, Math.floor((dimensions.min + dimensions.native) / 2)];
  if (dimensions.kind === 'discrete') return dimensions.values.filter(width => width !== dimensions.native);
  return [];
};

export function describeEmbeddingProviderConformance(name: string, setup: EmbeddingConformanceSetup): void {
  describe(`${name} embedding provider conformance`, () => {
    if (setup.beforeEach) beforeEach(setup.beforeEach);
    if (setup.afterEach) afterEach(setup.afterEach);

    it('registers against the catalog under a known provider id', () => {
      const provider = setup.provider();
      expect(EMBEDDING_PROVIDER_IDS).toContain(provider.id);
      expect(() => createEmbeddingProviderRegistry([provider])).not.toThrow();
    });

    it('rejects a model it does not serve before any network call', async () => {
      await setup.scenarios.succeeds();
      const provider = setup.provider();
      const foreign = EMBEDDING_MODEL_IDS.find(model => !provider.models.includes(model));
      if (!foreign) throw new Error('catalog holds no model outside this provider');
      const before = setup.requestCount();

      await expect(provider.embed({ model: foreign, inputs: ['a'] })).rejects.toThrow();
      expect(setup.requestCount()).toBe(before);
    });

    it('rejects without any request when the signal is already aborted', async () => {
      await setup.scenarios.succeeds();
      const provider = setup.provider();
      const [model] = provider.models;
      const before = setup.requestCount();

      await expect(provider.embed({ model, inputs: ['a'] }, { signal: AbortSignal.abort() })).rejects.toThrow();
      expect(setup.requestCount()).toBe(before);
    });

    if (setup.scenarios.unauthorized) {
      it('maps rejected credentials to EmbeddingAuthError', async () => {
        await setup.scenarios.unauthorized?.();
        const provider = setup.provider();
        const [model] = provider.models;

        const failure = await provider.embed({ model, inputs: ['a'] }).catch((error: unknown) => error);
        expect(isEmbeddingAuthError(failure)).toBe(true);
      });
    }

    for (const model of setup.provider().models) {
      describe(model, () => {
        const { dimensions } = getEmbeddingModelCapabilities(model);
        const inputs = ['alpha', 'bravo charlie', 'delta'];

        it('returns one native-width vector per input, in input order', async () => {
          await setup.scenarios.succeeds();
          const provider = setup.provider();

          const batch = await provider.embed({ model, inputs });
          expect(batch.vectors).toHaveLength(inputs.length);
          for (const vector of batch.vectors) expect(vector).toHaveLength(dimensions.native);

          for (const [index, input] of inputs.entries()) {
            const single = await provider.embed({ model, inputs: [input] });
            expect(batch.vectors[index]).toEqual(single.vectors[0]);
          }
          expect(new Set(batch.vectors.map(vector => JSON.stringify(vector))).size).toBe(inputs.length);
        });

        for (const width of nonNativeWidths(model)) {
          it(`serves width ${width}`, async () => {
            await setup.scenarios.succeeds();
            const { vectors } = await setup.provider().embed({ model, inputs, dimensions: width });
            expect(vectors).toHaveLength(inputs.length);
            for (const vector of vectors) expect(vector).toHaveLength(width);
          });
        }

        it('rejects an unsupported width before any network call', async () => {
          await setup.scenarios.succeeds();
          const before = setup.requestCount();

          await expect(setup.provider().embed({ model, inputs, dimensions: dimensions.native + 1 })).rejects.toThrow();
          expect(setup.requestCount()).toBe(before);
        });

        it('resolves empty inputs without a network call', async () => {
          await setup.scenarios.succeeds();
          const before = setup.requestCount();

          await expect(setup.provider().embed({ model, inputs: [] })).resolves.toEqual({ vectors: [] });
          expect(setup.requestCount()).toBe(before);
        });

        it('is all-or-nothing when a later request fails', async () => {
          await setup.scenarios.failsOnLateInput();
          const large = Array.from({ length: LARGE_BATCH_SIZE }, (_, index) => `input number ${index}`);
          expect(large.at(-1)).toBe(LATE_FAILURE_INPUT);

          await expect(setup.provider().embed({ model, inputs: large })).rejects.toThrow();
        });

        it(`keeps order across a ${LARGE_BATCH_SIZE}-input batch`, async () => {
          await setup.scenarios.succeeds();
          const large = Array.from({ length: LARGE_BATCH_SIZE }, (_, index) => `input number ${index}`);

          const { vectors } = await setup.provider().embed({ model, inputs: large });
          expect(vectors).toEqual(large.map(text => fakeEmbedding(text, dimensions.native)));
        });
      });
    }
  });
}
