import { describe, it, expect, vi, beforeEach } from 'vitest';

// Guardrail (extends the storage module guard):
// Service factory modules must defer SST `Resource.X` access (and storage getter calls)
// to first invocation of the factory - never at module load. A regression that moves
// any of `Resource.ImageProcessor`, `Resource.websocket`, or storage getter access into
// the module scope would re-introduce the cold-start crash class on Lambdas whose
// link array omits the relevant resource.
//
// We track every `Resource.X` access via a tracking Proxy that returns benign stubs
// (so unrelated module-load Resource access via `@server/utils/config` doesn't pollute
// the assertion). After import, the factory-specific keys must be absent. After
// invoking the factory, they must be present.

const resourceAccessLog: string[] = [];

const benignStub: ProxyHandler<object> = {
  get(_, key) {
    if (key === 'then') return undefined; // avoid being treated as thenable
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

// Mock the storage module so the factory body's `getFilesStorage()` / `getGeneratedImageStorage()`
// calls don't trigger their own `Resource.fabFileBucket.name` access. This isolates the
// assertion to: "did imageEdit.ts's own factory closure touch the resource?"
vi.mock('@server/utils/storage', () => ({
  getFilesStorage: vi.fn(() => ({ __mock: 'filesStorage' })),
  getGeneratedImageStorage: vi.fn(() => ({ __mock: 'generatedImageStorage' })),
}));

// Stub the service constructor - we don't care about its internals, only that the
// factory call site evaluates its arguments (which is where the Resource access lives).
vi.mock('@bike4mind/services', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/services')>('@bike4mind/services');
  // `class` (not arrow `vi.fn`) so `new ImageEditService(...)` works while still
  // evaluating the constructor args - where the `Resource.X` access we want to track lives.
  return {
    ...actual,
    ImageEditService: class MockImageEditService {
      constructor(_opts: unknown) {}
    },
  };
});

describe('imageEdit factory lazy contract', () => {
  beforeEach(() => {
    resourceAccessLog.length = 0;
    vi.resetModules();
  });

  // 20s timeout: vi.resetModules() forces a cold re-import of a heavy chain
  // (@bike4mind/services, database, observability) on each test, which can exceed
  // the 5s default on a loaded CI runner. Mirrors chatCompletionDefaults.test.ts.
  it('does not access ImageProcessor or websocket at module import', async () => {
    await import('./imageEdit');
    expect(resourceAccessLog).not.toContain('ImageProcessor');
    expect(resourceAccessLog).not.toContain('websocket');
  }, 20000);

  it('exports getImageEdit as a function (factory, not eager instance)', async () => {
    const mod = await import('./imageEdit');
    expect(typeof mod.getImageEdit).toBe('function');
  }, 20000);

  it('accesses ImageProcessor and websocket only when getImageEdit is invoked', async () => {
    const mod = await import('./imageEdit');
    resourceAccessLog.length = 0;
    mod.getImageEdit();
    expect(resourceAccessLog).toContain('ImageProcessor');
    expect(resourceAccessLog).toContain('websocket');
  }, 20000);
});
