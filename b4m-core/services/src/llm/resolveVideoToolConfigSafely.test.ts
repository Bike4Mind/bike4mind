import { describe, expect, it, vi } from 'vitest';
import { resolveVideoToolConfigSafely } from './resolveVideoToolConfigSafely';

describe('resolveVideoToolConfigSafely', () => {
  it('returns null without a resolver', async () => {
    expect(await resolveVideoToolConfigSafely(undefined, { warn: vi.fn() } as never)).toBeNull();
  });

  it('returns the resolved config', async () => {
    const config = { usableModels: ['test-video'], createJob: vi.fn() };
    expect(await resolveVideoToolConfigSafely(async () => config as never, { warn: vi.fn() } as never)).toBe(config);
  });

  it('degrades to null and warns when the resolver throws', async () => {
    const warn = vi.fn();
    const result = await resolveVideoToolConfigSafely(
      async () => {
        throw new Error('db down');
      },
      { warn } as never
    );
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});
