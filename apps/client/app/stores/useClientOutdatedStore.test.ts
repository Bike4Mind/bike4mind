import { beforeEach, describe, expect, it } from 'vitest';
import { useClientOutdatedStore } from './useClientOutdatedStore';

describe('useClientOutdatedStore', () => {
  beforeEach(() => useClientOutdatedStore.setState({ outdated: false }));

  it('does not start out outdated', () => {
    expect(useClientOutdatedStore.getInitialState().outdated).toBe(false);
  });

  it('markOutdated flips the flag', () => {
    useClientOutdatedStore.getState().markOutdated();
    expect(useClientOutdatedStore.getState().outdated).toBe(true);
  });
});
