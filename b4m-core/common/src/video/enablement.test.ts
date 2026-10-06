import { describe, expect, it } from 'vitest';
import { isVideoModelEnabled } from './enablement';

describe('isVideoModelEnabled', () => {
  it('falls back to the catalog default when no override exists', () => {
    expect(isVideoModelEnabled('test-video', undefined)).toBe(true);
  });

  it('ships Gemini Omni disabled until an admin turns it on', () => {
    expect(isVideoModelEnabled('gemini-omni-1.1-flash', undefined)).toBe(false);
    expect(isVideoModelEnabled('gemini-omni-1.1-flash', { enabledModels: {} })).toBe(false);
    expect(isVideoModelEnabled('gemini-omni-1.1-flash', { enabledModels: { 'gemini-omni-1.1-flash': true } })).toBe(
      true
    );
  });

  it('an override wins over the catalog default', () => {
    expect(isVideoModelEnabled('test-video', { enabledModels: { 'test-video': false } })).toBe(false);
  });
});
