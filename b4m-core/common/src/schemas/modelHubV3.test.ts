import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CuratedCatalogV3Schema, HubManifestV3Schema, hubLicenseLabel } from './modelHubV3';

type Doc = Record<string, any>; // any: the fixtures edit arbitrary parts of a JSON document

const repoV3 = (): Doc =>
  JSON.parse(readFileSync(new URL('../../../../catalog/model-hub/curated-v3.json', import.meta.url), 'utf8'));

function mutated(edit: (doc: Doc) => void): Doc {
  const doc = repoV3();
  edit(doc);
  return doc;
}

const entry = (doc: Doc, id: string): Doc => doc.entries.find((e: Doc) => e.id === id);
const profile = (doc: Doc, id: string, b = 0): Doc => entry(doc, id).builds[b].profiles[0];
const messages = (doc: Doc): string[] => {
  const result = HubManifestV3Schema.safeParse(doc);
  return result.success ? [] : result.error.issues.map(issue => issue.message);
};

describe('curated v3 schema', () => {
  it('accepts the repo list as a published catalog', () => {
    const result = CuratedCatalogV3Schema.safeParse(repoV3());
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });

  it('defaults a pick to text and a build to no profiles', () => {
    const parsed = HubManifestV3Schema.parse(
      mutated(d => {
        delete d.tiers[0].picks[0].modality;
        delete entry(d, 'gemma-4-12b').builds[0].profiles;
      })
    );
    expect(parsed.tiers[0].picks[0].modality).toBe('text');
    expect(parsed.entries.find(e => e.id === 'gemma-4-12b')?.builds[0].profiles).toEqual([]);
  });

  it('lists a non-permissive build with its label', () => {
    const doc = mutated(d => {
      const e = entry(d, 'gemma-4-12b');
      Object.assign(e.license, {
        id: 'gemma',
        spdx: false,
        class: 'restricted-commercial',
        label: 'Gemma Terms of Use',
        requiresAck: true,
        summary: 'Use is subject to the Gemma Terms of Use.',
        legalNote: 'Reviewed for listing.',
        cardTag: 'gemma',
      });
      Object.assign(e.builds[0].license, { id: 'gemma', spdx: false, class: 'restricted-commercial', label: 'Gemma' });
    });
    expect(messages(doc)).toEqual([]);
  });

  const rejected: [string, (doc: Doc) => void, RegExp][] = [
    ['a schemaVersion of 2', d => (d.schemaVersion = 2), /expected 3/i],
    ['a NaN metric', d => (profile(d, 'gemma-4-12b').metrics.decodeTokS = NaN), /expected number/i],
    ['an Infinity metric', d => (profile(d, 'gemma-4-12b').metrics.decodeTokS = Infinity), /expected number/i],
    ['a negative metric', d => (profile(d, 'gemma-4-12b').metrics.decodeTokS = -1), /too small/i],
    ['a metric key with a space', d => (profile(d, 'gemma-4-12b').metrics['decode tok'] = 1), /invalid/i],
    ['a build with no license label', d => delete entry(d, 'gemma-4-12b').builds[0].license.label, /expected string/i],
    [
      'a label with smart punctuation',
      d => (entry(d, 'gemma-4-12b').license.label = `Apache${String.fromCharCode(0x2014)}2.0`),
      /invalid/i,
    ],
    ['a label over 48 characters', d => (entry(d, 'gemma-4-12b').license.label = 'x'.repeat(49)), /too big/i],
    [
      'a quantized KV cache without flash attention',
      d => (profile(d, 'qwen3-5-9b').settings.flashAttn = 'auto'),
      /quantized KV cache needs flashAttn/,
    ],
    [
      'a profile context above the model maximum',
      d => (profile(d, 'gemma-4-e4b').settings.numCtx = 262144),
      /numCtx exceeds arch.contextMax/,
    ],
    [
      'a draft on a build with no draft or MTP layer',
      d => (profile(d, 'gemma-4-12b').settings.draftNumPredict = 2),
      /draftNumPredict needs a draft or MTP layer/,
    ],
    [
      'a duplicate profile id',
      d => entry(d, 'gemma-4-12b').builds[0].profiles.push(structuredClone(profile(d, 'gemma-4-12b'))),
      /duplicate profile quality/,
    ],
    [
      'a build license less restrictive than the base',
      d => {
        const e = entry(d, 'gemma-4-12b');
        Object.assign(e.license, { class: 'research', requiresAck: true, summary: 'Research use.', legalNote: 'x' });
        e.license.base.class = 'research';
      },
      /less restrictive than the base license/,
    ],
    [
      'a build license more restrictive than the entry',
      d => (entry(d, 'gemma-4-12b').builds[0].license.class = 'non-commercial'),
      /more restrictive than the entry license/,
    ],
    ['a text entry with a non-text role', d => entry(d, 'gemma-4-12b').roles.push('embeddings'), /invalid option/i],
    [
      'a pick in a slot its modality lacks',
      d => Object.assign(d.tiers[1].picks[2], { modality: 'embedding' }),
      /no long-context slot for embedding/,
    ],
    [
      'a long-context pick in a cpu tier',
      d => (d.tiers[9].picks[2].slot = 'long-context'),
      /no long-context slot in a cpu tier/,
    ],
    [
      'a pick of a text entry for another modality',
      d => Object.assign(d.tiers[1].picks[0], { modality: 'embedding' }),
      /is not a embedding entry/,
    ],
    [
      'a pick of a missing profile',
      d => (d.tiers[1].picks[0].profile = 'fast'),
      /no fast profile on qwen3-5-4b\/q4-k-m/,
    ],
    ['a pick context above the model maximum', d => (d.tiers[1].picks[2].numCtx = 262144), /numCtx exceeds/],
    ['a slot filled twice', d => (d.tiers[1].picks[1].slot = 'best'), /slot taken/],
    ['a ranking of an unknown entry', d => (d.rankings = { text: ['no-such-entry'] }), /no text entry no-such-entry/],
    ['a v2 channel build the entry lacks', d => d.v2Channel.entries[0].builds.push('q4-k-m'), /no build q4-k-m/],
    [
      'a v2 channel entry listed twice',
      d => d.v2Channel.entries.push(structuredClone(d.v2Channel.entries[0])),
      /listed twice/,
    ],
  ];

  it.each(rejected)('rejects %s', (_name, edit, message) => {
    expect(messages(mutated(edit)).join('\n')).toMatch(message);
  });
});

describe('hubLicenseLabel', () => {
  it('prefers the manifest label, then a known label, then the id', () => {
    expect(hubLicenseLabel({ id: 'apache-2.0', label: 'Apache License 2.0' })).toBe('Apache License 2.0');
    expect(hubLicenseLabel({ id: 'Apache-2.0' })).toBe('Apache 2.0');
    expect(hubLicenseLabel({ id: 'gemma' })).toBe('Gemma Terms of Use');
    expect(hubLicenseLabel({ id: 'llama3.1' })).toBe('llama3.1');
  });
});
