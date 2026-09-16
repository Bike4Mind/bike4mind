/**
 * `taggedAt` is a declared Session schema path, so every write in this handler now actually lands.
 * That makes the failure branch's bookkeeping load-bearing: while strict mode dropped the field,
 * the spider re-tagged every notebook on every run, so anything this handler got wrong healed
 * itself on the next pass. It no longer does, which is what these tests pin down.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  sessionUpdate: vi.fn(),
  questFindOne: vi.fn(),
  completionText: [] as (string | null)[],
  session: {} as Record<string, unknown>,
}));

// Passthrough the wrapper so the raw handler runs without connectDB / Config.
vi.mock('@server/events/utils', () => ({
  withEventContext: (fn: unknown) => fn,
}));

vi.mock('@server/utils/eventBus', () => ({
  SessionEvents: {
    Tag: { schema: { parse: (properties: unknown) => properties } },
  },
}));

vi.mock('@bike4mind/database', () => ({
  sessionRepository: {
    findById: vi.fn(async () => h.session),
    update: h.sessionUpdate,
  },
  userRepository: { findById: vi.fn(async (id: string) => ({ id, isAdmin: false })) },
  questRepository: { findOne: h.questFindOne },
}));

vi.mock('@client/services/operationsModelService', () => ({
  OperationsModelService: {
    getOperationsModel: async () => ({
      modelId: 'test-model',
      modelInfo: { name: 'Test Model', backend: 'test' },
      llm: {
        complete: async (
          _modelId: string,
          _messages: unknown,
          _options: unknown,
          onChunk: (chunk: (string | null)[]) => Promise<void>
        ) => {
          await onChunk(h.completionText);
        },
      },
    }),
  },
}));

vi.mock('@server/events/recordSessionOperationalUsage', () => ({
  recordSessionOperationalUsage: vi.fn(),
}));

import { handler } from './sessionTagging';

const SESSION_ID = 'session-1';
const OWNER = 'user-owner';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), updateMetadata: vi.fn() };

const run = () =>
  (handler as unknown as (event: unknown, logger: unknown) => Promise<void>)(
    { event: 'session.tag', properties: { sessionId: SESSION_ID, userId: OWNER } },
    logger
  );

describe('sessionTagging', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.completionText = [];
    h.questFindOne.mockResolvedValue({ id: 'quest-1', prompt: 'How do pulsars form?' });
    // Pre-existing tags, as a clone or an import leaves them. `updatedAt` is old enough to clear
    // the handler's 10s duplicate-processing guard.
    h.session = {
      id: SESSION_ID,
      _id: SESSION_ID,
      userId: OWNER,
      name: 'Notebook',
      tags: [{ name: 'inherited', strength: 5 }],
      updatedAt: new Date(Date.now() - 60_000),
    };
  });

  it('writes tags and taggedAt together when the model returns usable tags', async () => {
    h.completionText = ['[{"name": "pulsars", "strength": 9}]'];

    await run();

    expect(h.sessionUpdate).toHaveBeenCalledTimes(1);
    const written = h.sessionUpdate.mock.calls[0][0];
    expect(written.tags).toEqual([{ name: 'pulsars', strength: 9 }]);
    expect(written.taggedAt).toBeInstanceOf(Date);
  });

  it('stamps taggedAt but leaves existing tags untouched when the response cannot be parsed', async () => {
    h.completionText = ['I was unable to produce tags for this notebook.'];

    await run();

    expect(h.sessionUpdate).toHaveBeenCalledTimes(1);
    const written = h.sessionUpdate.mock.calls[0][0];
    expect(written.taggedAt).toBeInstanceOf(Date);
    expect(written).not.toHaveProperty('tags');
    expect(h.session.tags).toEqual([{ name: 'inherited', strength: 5 }]);
  });

  // An empty completion is a transient provider failure, not a verdict that the notebook has no
  // tags - it must not be allowed to clear tags the session already carries.
  it('does not clear tags when the completion comes back empty', async () => {
    h.completionText = [''];

    await run();

    const written = h.sessionUpdate.mock.calls[0][0];
    expect(written).not.toHaveProperty('tags');
    expect(h.session.tags).toEqual([{ name: 'inherited', strength: 5 }]);
  });

  it('marks an empty notebook as tagged with no tags', async () => {
    h.questFindOne.mockResolvedValue(null);
    h.session.tags = [];

    await run();

    const written = h.sessionUpdate.mock.calls[0][0];
    expect(written.tags).toEqual([]);
    expect(written.taggedAt).toBeInstanceOf(Date);
  });
});
