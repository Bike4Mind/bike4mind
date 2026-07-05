import { describe, it, expect, vi, beforeEach } from 'vitest';

// Guardrail for the chat completion lazy contract:
// `getDefaultChatCompletionOptions()` previously lived as a module-level
// `export const defaultChatCompletionOptions` whose body invoked `getFilesStorage()`,
// `getGeneratedImageStorage()`, `Resource.websocket.managementEndpoint`, and
// `Resource.SECRET_ENCRYPTION_KEY.value` at module load time. Any Lambda whose link
// array omitted those resources crashed at cold start the moment something in the
// import chain pulled this file in (e.g. just to grab `getSharedTokenizer`).
//
// This test guards the lazy promise by tracking every SST `Resource.X` access and
// asserting the chat-completion-specific keys (`websocket`, `SECRET_ENCRYPTION_KEY`,
// `mcpHandler`) are NOT touched at import but ARE touched when the factory is invoked.
// Storage and database modules are mocked to isolate this module's own contract from
// upstream Resource access via `@server/utils/config`.

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

// Mock `@server/utils/config` - its module body eagerly reads several `Resource.X.value`
// (notably `SECRET_ENCRYPTION_KEY`, `MONGODB_URI`, etc.) and would pollute the access
// log with import-time noise. That's a separate, pre-existing eager-Resource concern
// outside this PR's scope. Mocking here isolates the assertion to chatCompletionDefaults'
// own factory body.
vi.mock('@server/utils/config', () => ({
  Config: new Proxy({} as Record<string, unknown>, {
    get: (_, key) => `mock-config-${String(key)}`,
  }),
}));

describe('chatCompletionDefaults factory lazy contract', () => {
  beforeEach(() => {
    resourceAccessLog.length = 0;
    vi.resetModules();
  });

  // 20s timeout: vi.resetModules() forces a cold re-import of a heavy chain
  // (@bike4mind/database x 24 repos, mcp, services, observability) on each test.
  it('does not access websocket, SECRET_ENCRYPTION_KEY, or mcpHandler at module import', async () => {
    await import('./chatCompletionDefaults');
    expect(resourceAccessLog).not.toContain('websocket');
    expect(resourceAccessLog).not.toContain('SECRET_ENCRYPTION_KEY');
    expect(resourceAccessLog).not.toContain('mcpHandler');
  }, 20000);

  it('exports getDefaultChatCompletionOptions as a function (factory, not eager const)', async () => {
    const mod = await import('./chatCompletionDefaults');
    expect(typeof mod.getDefaultChatCompletionOptions).toBe('function');
  }, 20000);

  it('accesses websocket and SECRET_ENCRYPTION_KEY only when factory is invoked', async () => {
    const mod = await import('./chatCompletionDefaults');
    resourceAccessLog.length = 0;
    mod.getDefaultChatCompletionOptions();
    expect(resourceAccessLog).toContain('websocket');
    expect(resourceAccessLog).toContain('SECRET_ENCRYPTION_KEY');
  }, 20000);

  it('memoizes the result — repeated calls return the same reference', async () => {
    const mod = await import('./chatCompletionDefaults');
    const first = mod.getDefaultChatCompletionOptions();
    const second = mod.getDefaultChatCompletionOptions();
    expect(first).toBe(second);
  }, 20000);
});
