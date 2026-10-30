import { createHash } from 'node:crypto';
import type { HardwareProfile, HubBuild, HubEntry, HubManifest } from '@bike4mind/common';
import { describe, expect, it } from 'vitest';
import {
  curatedBuildForRef,
  curatedEntryForRef,
  curatedLibrary,
  curatedListing,
  curatedOllamaBlocked,
  curatedParamsLabel,
  curatedPicks,
  curatedRunner,
  curatedPins,
  curatedSource,
  installedReviewed,
  isCuratedListable,
  isCuratedPullable,
  loadCuratedManifest,
  servesReviewed,
} from './curated';
import type { ModelInspection, OllamaRegistryLayers } from './types';

const GIB = 1024 ** 3;
const manifest = (): HubManifest => structuredClone(loadCuratedManifest(() => {}));
const entryOf = (list: HubManifest, id: string): HubEntry => {
  const entry = list.entries.find(candidate => candidate.id === id);
  if (!entry) throw new Error(`no entry ${id} in the bundled list`);
  return entry;
};

function machine(overrides: Partial<HardwareProfile> = {}): HardwareProfile {
  return {
    platform: 'linux',
    arch: 'x64',
    memoryKind: 'discrete',
    totalMemoryBytes: 64 * GIB,
    gpuMemoryBytes: 24 * GIB,
    gpuName: 'Test GPU',
    gpuCount: 1,
    chip: null,
    diskFreeBytes: null,
    confidence: 'high',
    ...overrides,
  };
}

describe('curatedListing', () => {
  it('lists every bundled entry, smallest download first', () => {
    const list = manifest();
    const listing = curatedListing(list);
    expect(listing.map(({ entry }) => entry.id).sort()).toEqual(list.entries.map(entry => entry.id).sort());
    const smallest = listing.map(({ builds }) => Math.min(...builds.map(build => curatedSource(build).sizeBytes)));
    expect(smallest).toEqual([...smallest].sort((a, b) => a - b));
  });

  it('never lists an abliterated entry, whatever the policy says', () => {
    const flagged = manifest();
    entryOf(flagged, 'qwen3-5-4b').flags.abliterated = true;
    const named = manifest();
    entryOf(named, 'qwen3-5-4b').name = 'Qwen3.5 4B Abliterated';
    const variant = manifest();
    entryOf(variant, 'qwen3-5-4b').lineage.variantType = 'abliterated';
    for (const list of [flagged, named, variant]) {
      expect(isCuratedListable(entryOf(list, 'qwen3-5-4b'), list)).toBe(false);
      expect(curatedListing(list).map(({ entry }) => entry.id)).not.toContain('qwen3-5-4b');
    }
  });

  it('lists a restricted license only under the labelled policy', () => {
    const list = manifest();
    entryOf(list, 'qwen3-5-4b').license.class = 'restricted-commercial';
    expect(isCuratedListable(entryOf(list, 'qwen3-5-4b'), list)).toBe(true);
    list.policy.restrictedLicense = 'hidden';
    expect(isCuratedListable(entryOf(list, 'qwen3-5-4b'), list)).toBe(false);
  });

  it('drops an entry whose builds cannot be pulled as reviewed', () => {
    const list = manifest();
    const entry = entryOf(list, 'qwen3-8-27b-gsq');
    const [first] = entry.builds;
    const layers = first.ollama?.kind === 'hf-pull' ? first.ollama.layers : undefined;
    if (!layers) throw new Error('expected a pinned hf.co build');
    layers.installedTemplate = undefined;
    layers.template = null;
    expect(isCuratedPullable(first)).toBe(false);
    expect(
      curatedListing(list)
        .find(listed => listed.entry.id === entry.id)
        ?.builds.map(build => build.id)
    ).toEqual(entry.builds.slice(1).map(build => build.id));
    for (const build of entry.builds) build.ollama = undefined;
    expect(curatedListing(list).map(listed => listed.entry.id)).not.toContain(entry.id);
  });
});

describe('curatedSource', () => {
  it('pulls a library build by its library ref', () => {
    const build = entryOf(manifest(), 'qwen3-5-0-8b').builds[0];
    const source = curatedSource(build);
    expect(source.ollamaRef).toBe('qwen3.5:0.8b');
    expect(source).toMatchObject({ repo: 'qwen3.5:0.8b', pullBuildId: build.id });
    expect(source.sizeBytes).toBe(build.ollama?.kind === 'library' ? build.ollama.sizeBytes : NaN);
  });

  it('pulls an hf.co build by repo and quant, counting its pinned projector', () => {
    const build = entryOf(manifest(), 'qwen3-8-27b-gsq').builds[0];
    const projector = build.ollama?.kind === 'hf-pull' ? (build.ollama.layers?.projectorBytes ?? 0) : 0;
    expect(projector).toBeGreaterThan(0);
    expect(curatedSource(build)).toEqual({
      repo: build.hf?.repo,
      pullBuildId: build.weights[0].path.replace(/\.gguf$/, ''),
      sizeBytes: build.weights[0].sizeBytes + projector,
      ollamaRef: `hf.co/${build.hf?.repo}:${build.quant.label}`,
    });
  });
});

describe('curatedRunner', () => {
  it('asks for llamacpp on a library build and nothing on a Hugging Face build', () => {
    const list = manifest();
    const builds = list.entries.flatMap(entry => entry.builds);
    const library = builds.find(build => curatedLibrary(build));
    const hub = builds.find(build => build.ollama?.kind === 'hf-pull');
    if (!library || !hub) throw new Error('the bundled list lost a library or hf.co build');
    expect(curatedRunner(library)).toBe('llamacpp');
    expect(curatedRunner(hub)).toBeUndefined();
  });
});

describe('curatedBuildForRef', () => {
  it('finds a library build under the library/ prefix and an upper-cased ref', () => {
    const list = manifest();
    const entry = entryOf(list, 'qwen3-5-4b');
    const build = entry.builds[0];
    const ref = curatedSource(build).ollamaRef;
    expect(curatedBuildForRef(list, `library/${ref}`)).toEqual({ entry, build });
    expect(curatedBuildForRef(list, `LIBRARY/${ref.toUpperCase()}`)).toEqual({ entry, build });
  });

  it('matches a bare name to a library ref that ends in :latest, and the reverse', () => {
    const list = manifest();
    const entry = entryOf(list, 'qwen3-5-4b');
    const build = entry.builds[0];
    const library = curatedLibrary(build);
    if (!library) throw new Error('expected a library build');
    library.ref = 'fixture-model:latest';
    expect(curatedBuildForRef(list, 'fixture-model')).toEqual({ entry, build });
    expect(curatedBuildForRef(list, 'library/fixture-model:latest')).toEqual({ entry, build });
    library.ref = 'fixture-model';
    expect(curatedBuildForRef(list, 'fixture-model:latest')).toEqual({ entry, build });
    expect(curatedBuildForRef(list, 'fixture-model:4b')).toBeNull();
  });

  it('finds an offered build by its pull ref, ignoring case', () => {
    const list = manifest();
    for (const { entry, builds } of curatedListing(list))
      for (const build of builds) {
        const ref = curatedSource(build).ollamaRef;
        expect(curatedBuildForRef(list, ref.toUpperCase())).toEqual({ entry, build });
      }
    expect(curatedBuildForRef(list, 'qwen2.5:0.5b')).toBeNull();
  });

  it('finds nothing for an entry Curated does not offer', () => {
    const list = manifest();
    const entry = entryOf(list, 'qwen3-5-4b');
    const ref = curatedSource(entry.builds[0]).ollamaRef;
    entry.flags.abliterated = true;
    expect(curatedBuildForRef(list, ref)).toBeNull();
  });
});

describe('curatedEntryForRef', () => {
  it('finds the entry behind a library ref even when Curated does not offer it', () => {
    const list = manifest();
    const entry = entryOf(list, 'qwen3-5-4b');
    const ref = curatedSource(entry.builds[0]).ollamaRef;
    entry.flags.abliterated = true;
    expect(curatedEntryForRef(list, ref.toUpperCase())).toBe(entry);
    expect(curatedEntryForRef(list, 'qwen2.5:0.5b')).toBeNull();
  });

  it('finds an hf.co entry under huggingface.co exactly as under hf.co', () => {
    const list = manifest();
    const entry = entryOf(list, 'qwen3-8-27b-gsq');
    const repo = entry.builds[0].hf?.repo;
    for (const ref of [`huggingface.co/${repo}:Q2_K`, `HuggingFace.co/${repo?.toUpperCase()}`])
      expect(curatedEntryForRef(list, ref)).toBe(entry);
  });

  it('finds the entry behind a library ref given as library/<ref>', () => {
    const list = manifest();
    const entry = entryOf(list, 'qwen3-5-4b');
    const ref = curatedSource(entry.builds[0]).ollamaRef;
    expect(curatedEntryForRef(list, `library/${ref}`)).toBe(entry);
  });

  it('finds an hf.co entry by its repo, whatever quant or tag the ref names', () => {
    const list = manifest();
    const entry = entryOf(list, 'qwen3-8-27b-gsq');
    const repo = entry.builds[0].hf?.repo;
    for (const ref of [`hf.co/${repo}`, `hf.co/${repo}:Q2_K`, `HF.CO/${repo?.toUpperCase()}:latest`])
      expect(curatedEntryForRef(list, ref)).toBe(entry);
    expect(curatedEntryForRef(list, `hf.co/${repo}-other:Q4_K_M`)).toBeNull();
  });
});

describe('curatedPicks', () => {
  it("returns this machine's tier picks in slot order", () => {
    const list = manifest();
    const { tier, picks } = curatedPicks(list, machine());
    expect(tier).toMatchObject({ memoryKind: 'discrete', minGiB: 24 });
    expect(picks.map(({ pick }) => pick.slot)).toEqual(['best', 'fast', 'long-context']);
    for (const { pick, entry, build } of picks) expect([entry.id, build.id]).toEqual([pick.entry, pick.build]);
  });

  it('classes a discrete machine with unknown GPU memory as CPU only', () => {
    const { tier } = curatedPicks(manifest(), machine({ gpuMemoryBytes: null }));
    expect(tier?.memoryKind).toBe('cpu');
  });

  it('leaves out a pick whose entry Curated does not list', () => {
    const list = manifest();
    const { picks } = curatedPicks(list, machine());
    const dropped = picks[0].entry.id;
    entryOf(list, dropped).flags.abliterated = true;
    expect(curatedPicks(list, machine()).picks.map(({ entry }) => entry.id)).not.toContain(dropped);
  });

  it('has no tier when the list has none for this machine', () => {
    const list = manifest();
    list.tiers = [];
    expect(curatedPicks(list, machine())).toEqual({ tier: null, picks: [] });
  });
});

describe('curatedOllamaBlocked', () => {
  const build = () => entryOf(manifest(), 'qwen3-5-0-8b').builds[0];

  it('blocks an Ollama older than the build needs, or one that hides its version', () => {
    const minimum = build().runtimeMin?.ollama ?? '';
    expect(minimum).toMatch(/^\d+\.\d+\.\d+$/);
    expect(curatedOllamaBlocked(build(), minimum)).toBeNull();
    expect(curatedOllamaBlocked(build(), '999.0.0')).toBeNull();
    expect(curatedOllamaBlocked(build(), '0.0.1')).toBe(`Needs Ollama ${minimum} or newer`);
    expect(curatedOllamaBlocked(build(), null)).toBe(
      `Needs Ollama ${minimum} or newer, and Ollama did not report its version`
    );
  });
});

describe('curatedParamsLabel', () => {
  it('names active parameters for a mixture of experts', () => {
    const entry = entryOf(manifest(), 'qwen3-5-4b');
    expect(curatedParamsLabel({ ...entry, params: { ...entry.params, totalB: 26, activeB: 4 } })).toBe(
      '26B, 4B active'
    );
    expect(curatedParamsLabel({ ...entry, params: { ...entry.params, totalB: 4, activeB: null } })).toBe('4B');
  });
});

describe('servesReviewed and installedReviewed', () => {
  const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
  const libraryBuild = (): HubBuild => {
    const build = manifest()
      .entries.flatMap(entry => entry.builds)
      .find(candidate => curatedLibrary(candidate));
    if (!build) throw new Error('the bundled list lost its library build');
    return build;
  };
  const weightsOf = (build: HubBuild) => curatedLibrary(build)?.digest ?? build.weights[0].sha256;

  const servedLayers = (build: HubBuild): OllamaRegistryLayers => {
    const pins = curatedPins(build);
    return {
      model: weightsOf(build),
      others: (['template', 'params', 'license', 'projector', 'draft'] as const).flatMap(kind => {
        const digest = pins?.[kind];
        return digest ? [{ mediaType: `application/vnd.ollama.image.${kind}`, digest }] : [];
      }),
    };
  };

  // Pins the build's template and license to known texts, then reports an install whose contents match them.
  const installedAs = (build: HubBuild): ModelInspection => {
    const pins = curatedPins(build);
    if (!pins) throw new Error('expected a pinned build');
    const template = '{{ .Prompt }}';
    const license = 'A license text';
    if (pins.installedTemplate) pins.installedTemplate = sha256(template);
    else if (pins.template) pins.template = sha256(template);
    if (pins.license) pins.license = sha256(license);
    return {
      model: {
        name: 'fixture',
        sizeBytes: null,
        quantization: null,
        family: null,
        parameterSize: null,
        modifiedAt: null,
        capabilities: { tools: false, vision: false, thinking: false, embeddings: false, completion: true },
      },
      arch: null,
      tensorStats: null,
      parameters: pins.numCtx ? `num_ctx ${pins.numCtx}` : null,
      contents: {
        template: pins.installedTemplate || pins.template ? template : null,
        license: pins.license ? license : null,
        modelBlob: weightsOf(build),
        projectorBlobs: pins.projector ? [pins.projector] : [],
        draftBlobs: pins.draft ? [pins.draft] : [],
      },
    };
  };

  it('accepts a registry that serves the reviewed weights and exactly the pinned layers', () => {
    const build = libraryBuild();
    expect(servesReviewed(servedLayers(build), build)).toBe(true);
  });

  it('rejects a registry that serves other weights', () => {
    const build = libraryBuild();
    expect(servesReviewed({ ...servedLayers(build), model: 'f'.repeat(64) }, build)).toBe(false);
    expect(servesReviewed({ ...servedLayers(build), model: null }, build)).toBe(false);
  });

  it('rejects a registry that adds an unpinned layer', () => {
    const build = libraryBuild();
    const live = servedLayers(build);
    const extra = { mediaType: 'application/vnd.ollama.image.adapter', digest: 'f'.repeat(64) };
    expect(servesReviewed({ ...live, others: [...live.others, extra] }, build)).toBe(false);
  });

  it('accepts an install whose contents match the reviewed build', () => {
    const build = libraryBuild();
    expect(installedReviewed(installedAs(build), build)).toBe(true);
  });

  it('rejects an install with other weights', () => {
    const build = libraryBuild();
    const inspection = installedAs(build);
    const contents = inspection.contents && { ...inspection.contents, modelBlob: 'f'.repeat(64) };
    expect(installedReviewed({ ...inspection, contents }, build)).toBe(false);
  });

  it('rejects an install whose num_ctx differs from the pin', () => {
    const build = libraryBuild();
    const inspection = installedAs(build);
    const pinned = curatedPins(build)?.numCtx ?? null;
    expect(installedReviewed({ ...inspection, parameters: `num_ctx ${(pinned ?? 4096) + 1}` }, build)).toBe(false);
  });
});
