import { describe, expect, it } from 'vitest';
import { isVideoModelEnabled } from './enablement';

describe('isVideoModelEnabled', () => {
  it('falls back to the catalog default when no override exists', () => {
    expect(isVideoModelEnabled('test-video', undefined)).toBe(true);
  });

  it('an override wins over the catalog default', () => {
    expect(isVideoModelEnabled('test-video', { enabledModels: { 'test-video': false } })).toBe(false);
  });
});
