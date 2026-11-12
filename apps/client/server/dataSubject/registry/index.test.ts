import { describe, expect, it } from 'vitest';
import { DATA_HOLDER_REGISTRY, findUnclassifiedModels, mergeRegistries } from './index';
import { holderExportScope } from '../exportScope';
import type { DataHolderRegistry } from '../types';

const noData = { kind: 'noUserData', note: 'test' } as const;

describe('findUnclassifiedModels', () => {
  it('returns the names the registry does not classify', () => {
    expect(findUnclassifiedModels(['User', 'NotARealModel'])).toEqual(['NotARealModel']);
  });

  it('does not treat Object.prototype keys as classified', () => {
    expect(findUnclassifiedModels(['constructor'])).toEqual(['constructor']);
  });
});

describe('mergeRegistries', () => {
  it('merges disjoint registries', () => {
    const a: DataHolderRegistry = { A: noData };
    const b: DataHolderRegistry = { B: noData };
    expect(Object.keys(mergeRegistries([a, b])).sort()).toEqual(['A', 'B']);
  });

  it('throws when a model is classified in two registries', () => {
    const a: DataHolderRegistry = { A: noData };
    expect(() => mergeRegistries([a, a])).toThrow(/classified twice/);
  });
});

describe('private feedback note export policy', () => {
  it.each(['userId', 'author.id'])('excludes bodies from whole-record export policy for %s', path => {
    const holder = DATA_HOLDER_REGISTRY.FeedbackNote;
    if (holder.kind !== 'holder') throw new Error('FeedbackNote must be a holder');
    const references = holder.references.filter(reference => reference.path === path);
    expect(references).toHaveLength(1);
    expect(holderExportScope(references.map(reference => ({ reference, throughArray: false })))).toEqual({
      scope: 'wholeDocument',
    });
    expect(holder.secretPaths).toContain('body');
  });
});
