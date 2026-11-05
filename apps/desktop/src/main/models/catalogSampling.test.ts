import { createHash } from 'node:crypto';
import { curatedLibrary, curatedListing, curatedPins, curatedSource, ollamaRefAliases } from '@bike4mind/local-models';
import { describe, expect, it } from 'vitest';
import { catalogSampling } from './catalogSampling';
import { loadCuratedManifest } from './loadCuratedManifest';
import paramsLayers from './ollamaParamsLayers.fixture.json';

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

  it('seeds every curated library build as local Ollama reports it: weights blob plus its params layer', () => {
    const libraryBuilds = curatedListing(manifest)
      .flatMap(({ entry, builds }) => builds.map(build => ({ entry, library: curatedLibrary(build) })))
      .flatMap(({ entry, library }) => (library ? [{ entry, library }] : []));
    expect(libraryBuilds.length).toBeGreaterThan(0);
    const layers: Record<string, { params: Record<string, number> | null }> = paramsLayers;
    for (const { entry, library } of libraryBuilds) {
      const layer = layers[library.ref];
      expect(layer, library.ref).toBeDefined();
      const parameters = Object.entries(layer?.params ?? {})
        .map(([key, value]) => `${key.padEnd(20)}${value}`)
        .join('\n');
      const seed = catalogSampling(manifest, 'my-copy:latest', library.digest, parameters);
      expect(seed, library.ref).toBeDefined();
      expect(seed?.thinking?.temperature, library.ref).toBe(
        manifest.families[entry.family]?.sampling.thinking?.temperature
      );
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

  it('matches a copy under another name by its weights blob, and a llama-server model by its GGUF file name', () => {
    const qwen = manifest.entries.find(entry => entry.id === 'qwen3-5-4b')?.builds[0];
    const gsq = manifest.entries.find(entry => entry.id === 'qwen3-8-27b-gsq')?.builds[0];
    const blob = qwen?.ollama?.kind === 'library' ? qwen.ollama.digest : undefined;
    expect(blob).toBeDefined();
    expect(catalogSampling(manifest, 'my-qwen:latest', blob)).toEqual(catalogSampling(manifest, 'qwen3.5:4b'));
    expect(catalogSampling(manifest, 'gsq:latest', gsq?.weights[0].sha256)?.thinking).toMatchObject({ topK: 20 });
    expect(catalogSampling(manifest, `/models/${gsq?.weights[0].path}`)?.thinking).toMatchObject({ topK: 20 });
  });

  it("keeps the PARAMETER sampling of a model found by weights or file name, and a copy that sets the family's own", () => {
    const qwen = manifest.entries.find(entry => entry.id === 'qwen3-5-4b')?.builds[0];
    const gsq = manifest.entries.find(entry => entry.id === 'qwen3-8-27b-gsq')?.builds[0];
    const blob = qwen?.ollama?.kind === 'library' ? qwen.ollama.digest : undefined;
    const library = ['temperature 1', 'top_k 20', 'top_p 0.95', 'presence_penalty 1.5'].join('\n');
    const seeded = catalogSampling(manifest, 'qwen3.5:4b');
    expect(seeded).toBeDefined();
    expect(catalogSampling(manifest, 'my-variant:latest', blob, 'temperature 0.3')).toBeUndefined();
    expect(catalogSampling(manifest, 'my-variant:latest', blob, 'temperature 1\ntop_k 40')).toBeUndefined();
    expect(catalogSampling(manifest, 'my-copy:latest', blob, library)).toEqual(seeded);
    expect(catalogSampling(manifest, 'my-copy:latest', blob, 'num_ctx 8192')).toEqual(seeded);
    expect(catalogSampling(manifest, 'qwen3.5:4b', undefined, library)).toEqual(seeded);
    expect(catalogSampling(manifest, `/models/${gsq?.weights[0].path}`, undefined, 'temperature 0.3')).toBeUndefined();
  });

  it('keeps the PARAMETER sampling of a model listed under a curated ref', () => {
    expect(catalogSampling(manifest, 'qwen3.5:4b', undefined, 'temperature 0.3')).toBeUndefined();
  });

  it('seeds a curated pull ref by family even when its weights differ from the pin', () => {
    expect(catalogSampling(manifest, 'qwen3.5:4b', 'f'.repeat(64))).toEqual(catalogSampling(manifest, 'qwen3.5:4b'));
    expect(catalogSampling(manifest, 'qwen3.5:4b', 'f'.repeat(64), 'temperature 0.3')).toBeUndefined();
  });

  it('gives a model with an adapter no seed, even when named exactly like a curated ref', () => {
    const blob = manifest.entries.find(entry => entry.id === 'qwen3-5-4b')?.builds[0].ollama;
    const digest = blob?.kind === 'library' ? blob.digest : undefined;
    expect(catalogSampling(manifest, 'qwen3.5:4b', undefined, undefined, true)).toBeUndefined();
    expect(catalogSampling(manifest, 'qwen3.5:4b', digest, undefined, true)).toBeUndefined();
  });

  it('pins every params layer fixture entry to the manifest by the sha256 of its compact JSON and a newline', () => {
    const fixture: Record<string, { params: Record<string, number> | null }> = paramsLayers;
    const builds = curatedListing(manifest).flatMap(({ builds }) => builds);
    for (const [ref, { params }] of Object.entries(fixture)) {
      const build = builds.find(candidate => curatedSource(candidate).ollamaRef === ref);
      expect(build, ref).toBeDefined();
      const digest = createHash('sha256')
        .update(`${JSON.stringify(params)}\n`)
        .digest('hex');
      expect(digest, ref).toBe(build && curatedPins(build)?.params);
    }
  });

  it('gives no seed to a model that is not a reviewed build', () => {
    expect(catalogSampling(manifest, 'llama3.2:latest')).toBeUndefined();
    expect(catalogSampling(manifest, 'qwen3.8:27b-unreviewed-tag')).toBeUndefined();
    expect(catalogSampling(manifest, 'my-qwen:latest', 'f'.repeat(64))).toBeUndefined();
    expect(catalogSampling(manifest, '/models/Llama-3.2-3B-Q4_K_M.gguf')).toBeUndefined();
  });
});
