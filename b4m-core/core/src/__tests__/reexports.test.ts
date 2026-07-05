import { describe, it, expect } from 'vitest';
import * as core from '../index';
import * as common from '@bike4mind/common';

describe('@bike4mind/core re-exports', () => {
  it('re-exports all named exports from @bike4mind/common', () => {
    const commonKeys = Object.keys(common).sort();
    const coreKeys = Object.keys(core).sort();

    // core should have at least everything common has
    for (const key of commonKeys) {
      expect(coreKeys, `missing re-export: ${key}`).toContain(key);
    }
  });

  it('re-exports dayjs', () => {
    expect(core.dayjs).toBeDefined();
    expect(typeof core.dayjs).toBe('function');
  });
});
