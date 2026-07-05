import { describe, it, expect, vi, beforeEach } from 'vitest';

// Guardrail extending the storage module guard:
// See `imageEdit.test.ts` for the full rationale. This guards the same lazy contract
// for the videoGeneration factory module.

const resourceAccessLog: string[] = [];

const benignStub: ProxyHandler<object> = {
  get(_, key) {
    if (key === 'then') return undefined;
    return `mock-${String(key)}`;
  },
};

vi.mock('sst', () => ({
  Resource: new Proxy({} as Record<string, unknown>, {
    get(_, key) {
      const k = String(key);
      resourceAccessLog.push(k);
      return new Proxy({}, benignStub);
    },
  }),
}));

vi.mock('@server/utils/storage', () => ({
  getFilesStorage: vi.fn(() => ({ __mock: 'filesStorage' })),
  getGeneratedImageStorage: vi.fn(() => ({ __mock: 'generatedImageStorage' })),
}));

vi.mock('@bike4mind/services', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/services')>('@bike4mind/services');
  // `class` (not arrow `vi.fn`) so `new VideoGenerationService(...)` works while still
  // evaluating the constructor args - where the `Resource.X` access we want to track lives.
  return {
    ...actual,
    VideoGenerationService: class MockVideoGenerationService {
      constructor(_opts: unknown) {}
    },
  };
});

describe('videoGeneration factory lazy contract', () => {
  beforeEach(() => {
    resourceAccessLog.length = 0;
    vi.resetModules();
  });

  // 20s timeout: vi.resetModules() forces a cold re-import of a heavy chain
  // (@bike4mind/services, database, observability) on each test, which can exceed
  // the 5s default on a loaded CI runner. Mirrors chatCompletionDefaults.test.ts.
  it('does not access websocket at module import', async () => {
    await import('./videoGeneration');
    expect(resourceAccessLog).not.toContain('websocket');
  }, 20000);

  it('exports getVideoGeneration as a function (factory, not eager instance)', async () => {
    const mod = await import('./videoGeneration');
    expect(typeof mod.getVideoGeneration).toBe('function');
  }, 20000);

  it('accesses websocket only when getVideoGeneration is invoked', async () => {
    const mod = await import('./videoGeneration');
    resourceAccessLog.length = 0;
    mod.getVideoGeneration();
    expect(resourceAccessLog).toContain('websocket');
  }, 20000);
});
