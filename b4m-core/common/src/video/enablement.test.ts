import { describe, expect, it } from 'vitest';
import { isVideoModelEnabled } from './enablement';

describe('isVideoModelEnabled', () => {
  it('falls back to the catalog default when no override exists', () => {
    expect(isVideoModelEnabled('test-video', undefined)).toBe(true);
  });

  it.each(['gemini-omni-1.1-flash', 'grok-imagine-video-1.5', 'veo-3.1-fast-generate-preview'] as const)(
    'ships %s enabled, and an admin can turn it off',
    model => {
      expect(isVideoModelEnabled(model, undefined)).toBe(true);
      expect(isVideoModelEnabled(model, { enabledModels: { [model]: false } })).toBe(false);
    }
  );

  it('an override wins over the catalog default', () => {
    expect(isVideoModelEnabled('test-video', { enabledModels: { 'test-video': false } })).toBe(false);
  });
});
