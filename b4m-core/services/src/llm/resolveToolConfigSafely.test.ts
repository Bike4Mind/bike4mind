import { describe, expect, it, vi } from 'vitest';
import { resolveToolConfigSafely } from './resolveToolConfigSafely';

describe('resolveToolConfigSafely', () => {
  it('returns null without a resolver', async () => {
    expect(await resolveToolConfigSafely('video_generation', undefined, { warn: vi.fn() } as never)).toBeNull();
  });

  it('returns the resolved config', async () => {
    const config = { usableModels: ['test-video'], createJob: vi.fn() };
    expect(await resolveToolConfigSafely('video_generation', async () => config as never, { warn: vi.fn() } as never)).toBe(config);
  });

  it('degrades to null and warns when the resolver throws', async () => {
    const warn = vi.fn();
    const result = await resolveToolConfigSafely('video_generation', 
      async () => {
        throw new Error('db down');
      },
      { warn } as never
    );
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('video_generation'), expect.any(Error));
  });
});
