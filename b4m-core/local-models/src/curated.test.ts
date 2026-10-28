import type { HardwareProfile, HubEntry, HubManifest } from '@bike4mind/common';
import { describe, expect, it } from 'vitest';
import {
  curatedListing,
  curatedOllamaBlocked,
  curatedParamsLabel,
  curatedPicks,
  curatedSource,
  isCuratedListable,
  isCuratedPullable,
  loadCuratedManifest,
} from './curated';

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
