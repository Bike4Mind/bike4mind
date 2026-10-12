import { describe, expect, it } from 'vitest';
import { settingsMap } from '@bike4mind/common';
import { resolveRecommendedModelIds } from './recommendedModels';

describe('resolveRecommendedModelIds', () => {
  it('keeps a configured list in order and drops repeats', () => {
    expect(resolveRecommendedModelIds(['b', 'a', 'b'], 'x')).toEqual(['b', 'a']);
  });

  it('follows the admin-set DefaultAPIModel when the list is empty', () => {
    expect(resolveRecommendedModelIds([], 'admin-default')).toEqual(['admin-default']);
  });

  it.each([undefined, null, '', 42])('falls back to the compiled default when DefaultAPIModel is %s', value => {
    expect(resolveRecommendedModelIds([], value)).toEqual([settingsMap.DefaultAPIModel.defaultValue]);
  });

  it('treats a malformed stored value as empty', () => {
    expect(resolveRecommendedModelIds('not-a-list', 'admin-default')).toEqual(['admin-default']);
    expect(resolveRecommendedModelIds([1, null], 'admin-default')).toEqual(['admin-default']);
  });
});
