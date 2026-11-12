import { describe, expect, it } from 'vitest';
import { DATA_HOLDER_REGISTRY, findUnclassifiedModels, mergeRegistries } from './index';
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

describe('persona credential classification', () => {
  it('excludes the persisted one-use login verifier from user exports', () => {
    const user = DATA_HOLDER_REGISTRY.User;
    expect(user.kind).toBe('subject');
    if (user.kind !== 'subject') throw new Error('User must be a data subject');
    expect(user.secretPaths).toContain('personaLoginCodeHash');
  });
});
