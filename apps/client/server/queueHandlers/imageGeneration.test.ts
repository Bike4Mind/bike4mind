import { describe, it, expect, vi, beforeEach } from 'vitest';

// Guardrail (extends the storage module guard):
// See `imageEdit.test.ts` for the full rationale. This guards the same lazy contract
// for the imageGeneration factory module.

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
  // `class` (not arrow `vi.fn`) so `new ImageGenerationService(...)` works while still
  // evaluating the constructor args - where the `Resource.X` access we want to track lives.
  return {
    ...actual,
    ImageGenerationService: class MockImageGenerationService {
      constructor(_opts: unknown) {}
    },
  };
});

describe('imageGeneration factory lazy contract', () => {
  beforeEach(() => {
    resourceAccessLog.length = 0;
    vi.resetModules();
  });

  // 20s timeout: vi.resetModules() forces a cold re-import of a heavy chain
  // (@bike4mind/services, database, observability) on each test, which can exceed
  // the 5s default on a loaded CI runner. Mirrors chatCompletionDefaults.test.ts.
  it('does not access ImageProcessor or websocket at module import', async () => {
    await import('./imageGeneration');
    expect(resourceAccessLog).not.toContain('ImageProcessor');
    expect(resourceAccessLog).not.toContain('websocket');
  }, 20000);

  it('exports getImageGeneration as a function (factory, not eager instance)', async () => {
    const mod = await import('./imageGeneration');
    expect(typeof mod.getImageGeneration).toBe('function');
  }, 20000);

  it('accesses ImageProcessor and websocket only when getImageGeneration is invoked', async () => {
    const mod = await import('./imageGeneration');
    resourceAccessLog.length = 0;
    mod.getImageGeneration();
    expect(resourceAccessLog).toContain('ImageProcessor');
    expect(resourceAccessLog).toContain('websocket');
  }, 20000);
});
