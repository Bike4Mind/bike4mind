/**
 * `taggedAt` is a declared Session schema path, so every write in this handler now actually lands.
 * While strict mode dropped the field, the spider re-tagged every notebook on every run and
 * anything this handler got wrong healed itself on the next pass; it no longer does. These tests
 * pin the resulting invariant: the success branch is the handler's ONLY writer. Stamping
 * `taggedAt` closes the spider's `!taggedAt` gate (spider.ts) for good, so only a branch that
 * actually derived tags from the notebook's content may do it.
 *
 * `getOperationsModel` and `llm.complete` are spies rather than inert stubs because two of the
 * invariants here are about work NOT done: an early return must cost neither an admin-settings
 * resolve nor a completion. Asserting only on `sessionUpdate` cannot see either.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  sessionUpdate: vi.fn(),
  userFindById: vi.fn(),
  questFindOne: vi.fn(),
  getOperationsModel: vi.fn(),
  llmComplete: vi.fn(),
  recordUsage: vi.fn(),
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
    updateWithUpdateAccess: h.sessionUpdate,
  },
  userRepository: { findById: h.userFindById },
  questRepository: { findOne: h.questFindOne },
}));

vi.mock('@client/services/operationsModelService', () => ({
  OperationsModelService: { getOperationsModel: h.getOperationsModel },
}));

vi.mock('@server/events/recordSessionOperationalUsage', () => ({
  recordSessionOperationalUsage: h.recordUsage,
}));

import { handler } from './sessionTagging';

const SESSION_ID = 'session-1';
const OWNER = 'user-owner';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), updateMetadata: vi.fn() };

const run = (properties: Record<string, unknown> = { sessionId: SESSION_ID, userId: OWNER }) =>
  (handler as unknown as (event: unknown, logger: unknown) => Promise<void>)(
    { event: 'session.tag', properties },
    logger
  );

/** Every assertion that a branch spent nothing: no model resolve, no completion, no settlement. */
const expectNoOperationalSpend = () => {
  expect(h.getOperationsModel).not.toHaveBeenCalled();
  expect(h.llmComplete).not.toHaveBeenCalled();
  expect(h.recordUsage).not.toHaveBeenCalled();
};

describe('sessionTagging', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.completionText = [];
    h.userFindById.mockImplementation(async (id: string) => ({ id, isAdmin: false }));
    h.sessionUpdate.mockImplementation(async (_user: unknown, data: unknown) => data);
    h.questFindOne.mockResolvedValue({ id: 'quest-1', prompt: 'How do pulsars form?' });
    h.llmComplete.mockImplementation(
      async (
        _modelId: string,
        _messages: unknown,
        _options: unknown,
        onChunk: (chunk: (string | null)[]) => Promise<void>
      ) => {
        await onChunk(h.completionText);
      }
    );
    h.getOperationsModel.mockImplementation(async () => ({
      modelId: 'test-model',
      modelInfo: { name: 'Test Model', backend: 'test' },
      llm: { complete: h.llmComplete },
    }));
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
    const written = h.sessionUpdate.mock.calls[0][1];
    // `BaseModel.update` throws without it (b4m-core/db-core/src/models/BaseModel.ts), and the
    // repository is mocked here, so nothing else in this file would catch a dropped id.
    expect(written.id).toBe(SESSION_ID);
    expect(written.tags).toEqual([{ name: 'pulsars', strength: 9 }]);
    expect(written.taggedAt).toBeInstanceOf(Date);
    // Cleared explicitly, not omitted: an import overwrite reopens the gate by nulling `taggedAt`,
    // and a backoff left over from an earlier failure would hold the re-tag off for a full window.
    expect(written.tagLastAttemptAt).toBeNull();
  });

  describe('write-time access re-check', () => {
    const SHAREE = 'user-sharee';

    it('re-checks the owner when the job names no requester (spider, summarization)', async () => {
      h.completionText = ['[{"name": "pulsars", "strength": 9}]'];

      await run({ sessionId: SESSION_ID });

      expect(h.sessionUpdate).toHaveBeenCalledTimes(1);
      expect(h.sessionUpdate.mock.calls[0][0]).toMatchObject({ id: OWNER });
    });

    it('re-checks the requester, not the billed owner, for a sharee-triggered job', async () => {
      h.completionText = ['[{"name": "pulsars", "strength": 9}]'];

      await run({ sessionId: SESSION_ID, requesterId: SHAREE });

      expect(h.userFindById).toHaveBeenCalledWith(SHAREE);
      expect(h.sessionUpdate.mock.calls[0][0]).toMatchObject({ id: SHAREE });
      // Billing stays on the owner.
      expect(h.recordUsage).toHaveBeenCalledWith(
        expect.objectContaining({ user: expect.objectContaining({ id: OWNER }) })
      );
    });

    it('re-checks the requester on the no-usable-tags attempt stamp too', async () => {
      h.completionText = ['not json'];

      await run({ sessionId: SESSION_ID, requesterId: SHAREE });

      expect(h.sessionUpdate).toHaveBeenCalledTimes(1);
      expect(h.sessionUpdate.mock.calls[0][0]).toMatchObject({ id: SHAREE });
      expect(h.sessionUpdate.mock.calls[0][1]).toHaveProperty('tagLastAttemptAt');
    });

    it('drops the job before any spend when the requester no longer exists', async () => {
      h.userFindById.mockImplementation(async (id: string) => (id === SHAREE ? null : { id, isAdmin: false }));

      await expect(run({ sessionId: SESSION_ID, requesterId: SHAREE })).resolves.toBeUndefined();

      expectNoOperationalSpend();
      expect(h.sessionUpdate).not.toHaveBeenCalled();
    });

    it('warns and resolves when the write no longer matches (share revoked or session deleted)', async () => {
      h.completionText = ['[{"name": "pulsars", "strength": 9}]'];
      h.sessionUpdate.mockResolvedValue(null);

      await expect(run({ sessionId: SESSION_ID, requesterId: SHAREE })).resolves.toBeUndefined();

      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('no longer writable'));
    });
  });

  // A blank element is dropped, not allowed to normalize into an empty-named tag: one bad element
  // must not make the completion look usable and stamp `taggedAt`.
  it('keeps a usable tag when a sibling name is whitespace-only', async () => {
    h.completionText = ['[{"name": "  ", "strength": 5}, {"name": "pulsars", "strength": 9}]'];

    await run();

    expect(h.sessionUpdate).toHaveBeenCalledTimes(1);
    const written = h.sessionUpdate.mock.calls[0][1];
    expect(written.id).toBe(SESSION_ID);
    expect(written.tags).toEqual([{ name: 'pulsars', strength: 9 }]);
    expect(written.taggedAt).toBeInstanceOf(Date);
  });

  // The four inputs below all land in the same failure branch. The completion is already billed by
  // the time it runs, so it stamps the retry backoff - but it must stamp ONLY that: none of these
  // is a verdict that the notebook has no tags, so none may clear tags or close the spider gate.
  // Asserting on the payload rather than on `h.session.tags`: the fixture object is what the
  // mocked `findById` handed back, so asserting it still holds its tags cannot fail.
  it.each([
    ['an unparseable response', ['I was unable to produce tags for this notebook.']],
    ['an empty completion', ['']],
    ['a valid but empty JSON array', ['[]']],
    ['a whitespace-only tag name', ['[{"name":"   ","strength":5}]']],
  ])('stamps only the retry backoff on %s', async (_label, completion) => {
    h.completionText = completion as string[];

    await run();

    expect(h.sessionUpdate).toHaveBeenCalledTimes(1);
    const written = h.sessionUpdate.mock.calls[0][1];
    expect(written.id).toBe(SESSION_ID);
    expect(written.tagLastAttemptAt).toBeInstanceOf(Date);
    // Re-adding either of these is the regression this case exists to catch: a stamp makes one bad
    // completion a permanent "already tagged", a wipe destroys tags a clone or import carried in.
    expect(written).not.toHaveProperty('taggedAt');
    expect(written).not.toHaveProperty('tags');
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
  });

  // The ordering half of the no-quest case, and the reason the quest lookup sits ABOVE
  // `getOperationsModel`. A questless notebook is re-dispatched on every spider pass (nothing is
  // written to close the gate), so resolving admin settings, provider keys and the model catalog
  // there is a per-pass cost for zero completions.
  it('resolves no operations model for a notebook with no quests', async () => {
    h.questFindOne.mockResolvedValue(null);

    await run();

    expect(h.questFindOne).toHaveBeenCalledTimes(1);
    expectNoOperationalSpend();
  });

  describe('duplicate-processing guard', () => {
    // Two handlers racing the same session: the second sees tags written seconds ago and bails
    // rather than paying for a second completion over the same content.
    it('skips a session whose tags were written within the last 10s', async () => {
      h.session.updatedAt = new Date(Date.now() - 1_000);

      await run();

      expect(h.sessionUpdate).not.toHaveBeenCalled();
      expectNoOperationalSpend();
      // Bails before the quest lookup too, so the guard costs one session read and nothing else.
      expect(h.questFindOne).not.toHaveBeenCalled();
    });

    // The guard is scoped to sessions that ALREADY have tags. An untagged session updated a
    // moment ago (a rename, a share change) is the normal first-tagging case and must proceed.
    it('does not skip a recently updated session that has no tags', async () => {
      h.session.tags = [];
      h.session.updatedAt = new Date(Date.now() - 1_000);
      h.completionText = ['[{"name": "pulsars", "strength": 9}]'];

      await run();

      expect(h.sessionUpdate).toHaveBeenCalledTimes(1);
      expect(h.llmComplete).toHaveBeenCalledTimes(1);
    });

    // Past the 10s window the guard releases, so a stale tagged session can be re-tagged. This is
    // the branch the rest of this file's fixture depends on: it backdates `updatedAt` by 60s.
    it('does not skip a tagged session whose last update is older than 10s', async () => {
      h.session.updatedAt = new Date(Date.now() - 60_000);
      h.completionText = ['[{"name": "pulsars", "strength": 9}]'];

      await run();

      expect(h.sessionUpdate).toHaveBeenCalledTimes(1);
    });

    // `updatedAt` is optional on the session type, and the guard only reads the clock when it is
    // present. A tagged session with no `updatedAt` therefore falls through rather than being
    // treated as infinitely recent.
    it('does not skip a tagged session with no updatedAt', async () => {
      delete h.session.updatedAt;
      h.completionText = ['[{"name": "pulsars", "strength": 9}]'];

      await run();

      expect(h.sessionUpdate).toHaveBeenCalledTimes(1);
    });
  });
});
