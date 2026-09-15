import { describe, it, expect, vi } from 'vitest';

// Guardrail: importing this module must NOT touch SST `Resource`.
// If any future change re-introduces eager `Resource.X.name` access at module load,
// every Lambda whose link array omits the bucket crashes at cold start.
vi.mock('sst', () => ({
  Resource: new Proxy({} as Record<string, unknown>, {
    get(_, key) {
      throw new Error(`SST Resource.${String(key)} accessed — storage module must be lazy`);
    },
  }),
}));

describe('storage module lazy contract', () => {
  it('does not access SST Resource at import time', async () => {
    await expect(import('./index')).resolves.toBeDefined();
  });

  it('exports getter functions, not eager instances', async () => {
    const mod = await import('./index');
    expect(typeof mod.getFilesStorage).toBe('function');
    expect(typeof mod.getGeneratedImageStorage).toBe('function');
  });

  it('accesses SST Resource only when getFilesStorage is invoked', async () => {
    const { getFilesStorage } = await import('./index');
    expect(() => getFilesStorage()).toThrow(/SST Resource\.fabFileBucket accessed/);
  });

  it('accesses SST Resource only when getGeneratedImageStorage is invoked', async () => {
    const { getGeneratedImageStorage } = await import('./index');
    expect(() => getGeneratedImageStorage()).toThrow(/SST Resource\.generatedImagesBucket accessed/);
  });
});
