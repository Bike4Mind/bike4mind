/**
 * `taggedAt` is a declared Session schema path, so every write in this handler now actually lands.
 * While strict mode dropped the field, the spider re-tagged every notebook on every run and
 * anything this handler got wrong healed itself on the next pass; it no longer does. These tests
 * pin the resulting invariant: the success branch is the handler's ONLY writer. Stamping
 * `taggedAt` closes the spider's `!taggedAt` gate (spider.ts) for good, so only a branch that
 * actually derived tags from the notebook's content may do it.
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

  it('writes tags, taggedAt and the identifying id when the model returns usable tags', async () => {
    h.completionText = ['[{"name": "pulsars", "strength": 9}]'];

    await run();

    expect(h.sessionUpdate).toHaveBeenCalledTimes(1);
    const written = h.sessionUpdate.mock.calls[0][0];
    // `BaseModel.update` throws without it (b4m-core/db-core/src/models/BaseModel.ts), and the
    // repository is mocked here, so nothing else in this file would catch a dropped id.
    expect(written.id).toBe(SESSION_ID);
    expect(written.tags).toEqual([{ name: 'pulsars', strength: 9 }]);
    expect(written.taggedAt).toBeInstanceOf(Date);
  });

  // The three inputs below all land in the same failure branch. Each is transient: none of them
  // is a verdict that the notebook has no tags, so none may clear tags or close the spider gate.
  it.each([
    ['an unparseable response', ['I was unable to produce tags for this notebook.']],
    ['an empty completion', ['']],
    ['a valid but empty JSON array', ['[]']],
  ])('writes nothing on %s', async (_label, completion) => {
    h.completionText = completion as string[];

    await run();

    expect(h.sessionUpdate).not.toHaveBeenCalled();
    expect(h.session.tags).toEqual([{ name: 'inherited', strength: 5 }]);
  });

  // A notebook with no quests never reached the model, so it has earned neither a stamp nor a
  // tag wipe. Inherited tags are the destructive case: a clone or an import leaves them on a
  // session that carries no quests of its own.
  it.each([
    ['inherited tags', [{ name: 'inherited', strength: 5 }]],
    ['no tags', []],
  ])('writes nothing for a notebook with no quests and %s', async (_label, tags) => {
    h.questFindOne.mockResolvedValue(null);
    h.session.tags = tags;

    await run();

    expect(h.sessionUpdate).not.toHaveBeenCalled();
    expect(h.session.tags).toEqual(tags);
  });
});
