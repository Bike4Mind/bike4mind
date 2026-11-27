import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CuratedCatalogSchema } from '../schemas/modelHub';
import { curatedV2FromV3 } from './curatedV2';

type Doc = Record<string, any>; // any: the fixtures edit arbitrary parts of a JSON document

const read = (name: string): Doc =>
  JSON.parse(readFileSync(new URL(`../../../../catalog/model-hub/${name}`, import.meta.url), 'utf8'));

describe('curatedV2FromV3', () => {
  it('reproduces the bundled v2 list, key order included', () => {
    expect(JSON.stringify(curatedV2FromV3(read('curated-v3.json')))).toBe(JSON.stringify(read('curated-v2.json')));
  });

  it('emits a v2 list without v3-only fields or unused families', () => {
    const v2 = curatedV2FromV3(read('curated-v3.json'));
    expect(CuratedCatalogSchema.safeParse(v2).success).toBe(true);
    const text = JSON.stringify(v2);
    const v3Only = ['"modality"', '"profiles"', '"label":"Apache 2.0"', '"v2Channel"', 'contentSha256', '"note"'];
    for (const key of [...v3Only, 'qwen3-6']) expect(text).not.toContain(key);
    for (const entry of v2.entries) expect(entry.capabilities.embeddings).toBe(false);
  });

  it('drops keys v2 does not define, at any depth', () => {
    const v3 = read('curated-v3.json');
    v3.stray = 1;
    v3.entries[0].stray = 1;
    v3.entries[0].arch.stray = 1;
    v3.entries[0].builds[0].stray = 1;
    v3.entries[0].builds[0].ollama.layers.stray = 1;
    v3.v2Channel.tiers[0].picks[0].stray = 1;
    const v2 = curatedV2FromV3(v3 as never);
    expect(JSON.stringify(v2)).not.toContain('stray');
    expect(JSON.stringify(v2)).toBe(JSON.stringify(read('curated-v2.json')));
  });

  it('follows the channel, not the v3 order or picks', () => {
    const v3 = read('curated-v3.json');
    v3.v2Channel.entries.reverse();
    v3.v2Channel.entries.find((e: Doc) => e.entry === 'qwen3-8-27b-gsq').builds = ['iq2-xs', 'iq3-s'];
    const v2 = curatedV2FromV3(v3);
    const v2Ids = read('curated-v2.json').entries.map((e: Doc) => e.id);
    expect(v2.entries.map(entry => entry.id)).toEqual(v2Ids.reverse());
    expect(v2.entries.find(entry => entry.id === 'qwen3-8-27b-gsq')?.builds.map(build => build.id)).toEqual([
      'iq2-xs',
      'iq3-s',
    ]);
    expect(v2.tiers).toEqual(read('curated-v2.json').tiers);
  });

  it('throws on a list with no v2 channel', () => {
    const v3 = read('curated-v3.json');
    delete v3.v2Channel;
    expect(() => curatedV2FromV3(v3 as never)).toThrow(/no v2Channel/);
  });

  it('throws on an invalid v3 list instead of emitting a partial v2 one', () => {
    const v3 = read('curated-v3.json');
    v3.v2Channel.entries[0].entry = 'qwen3-5-9b';
    expect(() => curatedV2FromV3(v3 as never)).toThrow();
    const broken = read('curated-v3.json');
    broken.entries[0].builds[0].profiles[0].metrics.decodeTokS = Number.NaN;
    expect(() => curatedV2FromV3(broken as never)).toThrow();
  });

  it('throws when the v2 result breaks a v2 rule', () => {
    const v3 = read('curated-v3.json');
    // A v2 tier naming a build the channel leaves out fails the v2 schema.
    v3.v2Channel.entries.find((e: Doc) => e.entry === 'qwen3-8-27b').builds = ['q8-0'];
    expect(() => curatedV2FromV3(v3 as never)).toThrow();
  });
});
