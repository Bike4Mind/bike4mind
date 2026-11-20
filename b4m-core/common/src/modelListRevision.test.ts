import { describe, expect, it } from 'vitest';
import { MODEL_LIST_REVISION_CACHE_KEY, modelListRevisionOf } from './modelListRevision';

describe('modelListRevisionOf', () => {
  it('reads the stamp off a cache row', () => {
    expect(modelListRevisionOf({ result: { revision: 'r1' } })).toBe('r1');
  });

  it('reads a missing or malformed row as unset', () => {
    expect(modelListRevisionOf(null)).toBeNull();
    expect(modelListRevisionOf({ result: {} })).toBeNull();
    expect(modelListRevisionOf({ result: { revision: 7 } })).toBeNull();
    expect(modelListRevisionOf({ result: { revision: '' } })).toBeNull();
  });

  it('keeps the revision key outside the per-caller model-list:* namespace', () => {
    expect(MODEL_LIST_REVISION_CACHE_KEY.startsWith('model-list:')).toBe(false);
  });
});
