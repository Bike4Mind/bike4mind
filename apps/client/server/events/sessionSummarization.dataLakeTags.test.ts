import { describe, it, expect, vi, beforeEach } from 'vitest';

// Narrow harness: it drives the real handler only far enough to reach the summary FabFile write,
// which is where a notebook's tags used to overwrite the file's data-lake membership.
const h = vi.hoisted(() => ({
  updateFabFile: vi.fn(),
  createFabFile: vi.fn(),
  findOne: vi.fn(),
  sessionFindById: vi.fn(),
  userFindById: vi.fn(),
  questFind: vi.fn(),
  complete: vi.fn(),
  publishTag: vi.fn(),
  parse: vi.fn((properties: unknown) => properties),
}));

const logger = {
  updateMetadata: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

vi.mock('@server/events/utils', () => ({
  withEventContext: (fn: (event: unknown, log: unknown) => Promise<void>) => (event: unknown) => fn(event, logger),
}));
vi.mock('@server/utils/eventBus', () => ({
  SessionEvents: {
    Summarize: { schema: { parse: h.parse } },
    Tag: { publish: h.publishTag },
  },
}));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  fabFileRepository: { findOne: h.findOne },
  Quest: { find: h.questFind },
  Session: { findById: h.sessionFindById },
  sessionRepository: { update: vi.fn() },
  User: { findById: h.userFindById },
  userRepository: {},
  withTransaction: async (fn: (session: unknown) => Promise<unknown>) => fn({}),
}));
vi.mock('@client/services/operationsModelService', () => ({
  OperationsModelService: {
    getOperationsModel: async () => ({
      modelId: 'm1',
      llm: { complete: h.complete },
      modelInfo: { name: 'M1', backend: 'test' },
    }),
  },
}));
vi.mock('@bike4mind/services', () => ({
  fabFilesService: { updateFabFile: h.updateFabFile, createFabFile: h.createFabFile },
}));
vi.mock('@server/utils/storage', () => ({
  getFilesStorage: () => ({ upload: vi.fn(), getSignedUrl: vi.fn(async () => 'signed') }),
}));
vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn() }));
vi.mock('@server/events/recordSessionOperationalUsage', () => ({ recordSessionOperationalUsage: vi.fn() }));

import { handler } from './sessionSummarization';

const SESSION_TAGS = [{ name: 'research', strength: 1 }];

const run = () => (handler as (event: unknown) => Promise<void>)({ properties: { sessionId: 's1', userId: 'u1' } });

describe('sessionSummarization - the summary file keeps its data-lake membership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.parse.mockImplementation((properties: unknown) => properties);
    h.sessionFindById.mockResolvedValue({ id: 's1', userId: 'u1', name: 'Notebook', tags: SESSION_TAGS });
    h.userFindById.mockResolvedValue({ id: 'u1' });
    h.questFind.mockReturnValue({
      sort: () => ({ limit: async () => [{ _id: 'q1', prompt: 'p', reply: 'r' }] }),
    });
    h.complete.mockImplementation(async (_m: string, _msg: unknown, _o: unknown, cb: (c: unknown[]) => void) => {
      cb(['a summary']);
    });
    h.updateFabFile.mockResolvedValue({ id: 'ff1', filePath: 'p.txt' });
    h.createFabFile.mockResolvedValue({ id: 'ff1', filePath: 'p.txt', mimeType: 'text/plain' });
  });

  const tagsWrittenTo = (mock: { mock: { calls: unknown[][] } }, argIndex: number) =>
    (mock.mock.calls[0][argIndex] as { tags: { name: string }[] }).tags;

  it('carries an existing lake meta-tag through a re-summarization', async () => {
    h.findOne.mockResolvedValue({ id: 'ff1', tags: [{ name: 'datalake:lake', strength: 1 }, { name: 'stale' }] });

    await run();

    // The notebook's own tags win for ordinary tags, but membership survives.
    expect(tagsWrittenTo(h.updateFabFile, 1)).toEqual([
      { name: 'research', strength: 1 },
      { name: 'datalake:lake', strength: 1 },
    ]);
  });

  // No actor to authorize against here, so a session tag must not buy lake membership the
  // user-facing write doors would have gated.
  it('refuses to let a notebook tag inject the summary file into a lake', async () => {
    h.findOne.mockResolvedValue({ id: 'ff1', tags: [] });
    h.sessionFindById.mockResolvedValue({
      id: 's1',
      userId: 'u1',
      name: 'Notebook',
      tags: [
        { name: 'research', strength: 1 },
        { name: 'datalake:injected', strength: 1 },
      ],
    });

    await run();

    expect(tagsWrittenTo(h.updateFabFile, 1)).toEqual([{ name: 'research', strength: 1 }]);
  });

  it('strips an injected meta-tag on the create path too', async () => {
    h.findOne.mockResolvedValue(null);
    h.sessionFindById.mockResolvedValue({
      id: 's1',
      userId: 'u1',
      name: 'Notebook',
      tags: [{ name: 'datalake:injected', strength: 1 }],
    });

    await run();

    expect(tagsWrittenTo(h.createFabFile, 1)).toEqual([]);
  });
});
