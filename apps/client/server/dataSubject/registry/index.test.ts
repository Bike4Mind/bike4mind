import { describe, expect, it } from 'vitest';
import { findUnclassifiedModels, mergeRegistries } from './index';
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
