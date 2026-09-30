import { describe, it, expect, vi } from 'vitest';

// This exercises only the db-adapter assembly in getDefaultChatCompletionOptions: the surface
// save_content_to_data_lake (-> saveContentAdapters in adapters.ts) reads from. The heavy
// transitive imports (storage, sst Resource, event bus) are stubbed so importing the module
// doesn't require real AWS resources; the DB repositories come through actual so their shapes
// stay honest.

const benignStub: ProxyHandler<object> = {
  get(_, key) {
    if (key === 'then') return undefined;
    return `mock-${String(key)}`;
  },
};

vi.mock('sst', () => ({
  Resource: new Proxy({} as Record<string, unknown>, {
    get() {
      return new Proxy({}, benignStub);
    },
  }),
}));

vi.mock('@server/utils/config', () => ({
  Config: new Proxy({} as Record<string, unknown>, {
    get: (_, key) => `mock-${String(key)}`,
  }),
}));

vi.mock('@server/utils/storage', () => ({
  getFilesStorage: () => ({}),
  getGeneratedImageStorage: () => ({ download: vi.fn() }),
}));

vi.mock('@server/utils/eventBus', () => ({
  LLMEvents: { CompletionCompleted: { publish: vi.fn() } },
  TelemetryEvents: { Alert: { publish: vi.fn() } },
  SessionEvents: { AutoName: { publish: vi.fn() } },
}));

vi.mock('@bike4mind/services', () => ({
  apiKeyService: { getEffectiveLLMApiKeys: vi.fn() },
}));

vi.mock('@casl/mongoose', () => ({ accessibleBy: () => ({ ofType: () => ({}) }) }));

vi.mock('@bike4mind/database', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/database')>('@bike4mind/database');
  return { ...actual };
});

describe('getDefaultChatCompletionOptions', () => {
  it('wires the save_content_to_data_lake audit adapters', async () => {
    const { getDefaultChatCompletionOptions } = await import('./chatCompletionDefaults');

    const { db } = getDefaultChatCompletionOptions();

    // Without any one of these, saveContentAdapters() in
    // b4m-core/services/src/llm/tools/implementation/dataLakeContent/adapters.ts returns null and
    // the tool answers NOT_AVAILABLE instead of saving.
    expect(db.lakeMembershipRemovals).toBeDefined();
    expect(db.lakeConfigChangeEvents).toBeDefined();
    expect(db.lakeMembershipChangeEvents).toBeDefined();
  });
});
