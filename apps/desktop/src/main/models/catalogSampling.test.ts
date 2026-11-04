import { curatedListing, curatedSource, ollamaRefAliases } from '@bike4mind/local-models';
import { describe, expect, it } from 'vitest';
import { catalogSampling } from './catalogSampling';
import { loadCuratedManifest } from './loadCuratedManifest';

const manifest = loadCuratedManifest(() => undefined);

describe('catalogSampling', () => {
  it('gives every reviewed build a seed under each name Ollama lists it by', () => {
    const builds = curatedListing(manifest).flatMap(({ entry, builds }) => builds.map(build => ({ entry, build })));
    expect(builds.length).toBeGreaterThan(0);
    for (const { entry, build } of builds) {
      const family = manifest.families[entry.family];
      for (const name of ollamaRefAliases(curatedSource(build).ollamaRef)) {
        const seed = catalogSampling(manifest, name);
        expect(seed, name).toBeDefined();
        expect(seed?.thinking?.temperature, name).toBe(family?.sampling.thinking?.temperature);
        expect(seed?.nonThinking?.temperature, name).toBe(family?.sampling.nonThinking?.temperature);
      }
    }
  });

  it("maps a family's sampling to generation fields, including the pinned repeat penalty", () => {
    expect(catalogSampling(manifest, 'qwen3.5:4b')).toEqual({
      thinking: { temperature: 1, topP: 0.95, topK: 20, minP: 0, presencePenalty: 1.5, repeatPenalty: 1 },
    });
    expect(catalogSampling(manifest, 'gemma4:12b-it-qat')).toMatchObject({
      thinking: { temperature: 1, topP: 0.95, topK: 64 },
      nonThinking: { temperature: 1, topP: 0.95, topK: 64 },
    });
  });

  it('matches an hf.co build by its pull ref, in any case', () => {
    expect(catalogSampling(manifest, 'hf.co/ista-daslab/qwen3.8-27b-gsq-rco-gguf:iq3_s')?.thinking).toMatchObject({
      temperature: 1,
      topK: 20,
    });
  });

  it('gives no seed to a model that is not a reviewed build', () => {
    expect(catalogSampling(manifest, 'llama3.2:latest')).toBeUndefined();
    expect(catalogSampling(manifest, 'qwen3.8:27b-unreviewed-tag')).toBeUndefined();
  });
});
