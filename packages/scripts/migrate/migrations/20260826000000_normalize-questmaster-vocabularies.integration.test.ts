import { SUBQUEST_STATUS_VALUES } from '@bike4mind/common';
import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMongoServer } from '../../../database/src/__test__/createMongoServer';

vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260826000000_normalize-questmaster-vocabularies';

const COLLECTION = 'questmasterplans';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  await mongoose.connection.db?.createCollection(COLLECTION).catch(() => {});
  await mongoose.connection.db!.collection(COLLECTION).deleteMany({});
});

const plans = () => mongoose.connection.db!.collection(COLLECTION);

type SeedSubQuest = { id: string; title: string; status: unknown };

const insertPlan = async (quests: { id: string; complexity: unknown; subQuests: SeedSubQuest[] }[]) => {
  const result = await plans().insertOne({
    notebookId: 'session1',
    goal: 'Plan under migration',
    state: 'active',
    quests: quests.map(q => ({ ...q, title: `Quest ${q.id}`, description: 'd' })),
  });
  return result.insertedId;
};

const statusesOf = async (id: mongoose.Types.ObjectId) => {
  const doc = await plans().findOne({ _id: id });
  return (doc!.quests as { subQuests: { status: string }[] }[]).flatMap(q => q.subQuests.map(sq => sq.status));
};

const complexitiesOf = async (id: mongoose.Types.ObjectId) => {
  const doc = await plans().findOne({ _id: id });
  return (doc!.quests as { complexity: string }[]).map(q => q.complexity);
};

/**
 * Real mongod, not mocks: the migration is entirely a raw-driver read-modify-write over nested
 * arrays, and the two-level $elemMatch filter is the part most likely to be subtly wrong. A
 * mocked collection would happily agree with a filter that matches nothing in reality.
 */
describe('normalize-questmaster-vocabularies migration (real DB)', () => {
  it('rewrites every retired status token to its canonical value', async () => {
    const id = await insertPlan([
      {
        id: 'q1',
        complexity: 'Medium',
        subQuests: [
          { id: 'sq1', title: 'a', status: 'completed' },
          { id: 'sq2', title: 'b', status: 'in-progress' },
          { id: 'sq3', title: 'c', status: 'pending' },
          { id: 'sq4', title: 'd', status: 'blocked' },
        ],
      },
    ]);

    await migration.up();

    expect(await statusesOf(id)).toEqual(['completed', 'in_progress', 'not_started', 'not_started']);
  });

  it('rewrites retired lowercase complexity ratings', async () => {
    const id = await insertPlan([
      { id: 'q1', complexity: 'low', subQuests: [{ id: 'sq1', title: 'a', status: 'completed' }] },
      { id: 'q2', complexity: 'medium', subQuests: [{ id: 'sq2', title: 'b', status: 'completed' }] },
      { id: 'q3', complexity: 'high', subQuests: [{ id: 'sq3', title: 'c', status: 'completed' }] },
    ]);

    await migration.up();

    expect(await complexitiesOf(id)).toEqual(['Easy', 'Medium', 'Hard']);
  });

  it('leaves an already-clean plan completely untouched', async () => {
    const id = await insertPlan([
      {
        id: 'q1',
        complexity: 'Hard',
        subQuests: SUBQUEST_STATUS_VALUES.map((status, i) => ({ id: `sq${i}`, title: `t${i}`, status })),
      },
    ]);
    const before = await plans().findOne({ _id: id });

    await migration.up();

    // Deep equality, not just the status list: a clean plan must not be rewritten at all, since
    // an unnecessary write would churn every plan in the collection on every deploy.
    expect(await plans().findOne({ _id: id })).toEqual(before);
  });

  it('is idempotent - a second run changes nothing', async () => {
    const id = await insertPlan([
      {
        id: 'q1',
        complexity: 'low',
        subQuests: [
          { id: 'sq1', title: 'a', status: 'in-progress' },
          { id: 'sq2', title: 'b', status: 'pending' },
        ],
      },
    ]);

    await migration.up();
    const afterFirst = await plans().findOne({ _id: id });
    await migration.up();

    expect(await plans().findOne({ _id: id })).toEqual(afterFirst);
  });

  it('skips an undocumented token instead of guessing, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const id = await insertPlan([
      {
        id: 'q1',
        complexity: 'Medium',
        subQuests: [
          { id: 'sq1', title: 'a', status: 'in-progress' },
          { id: 'sq2', title: 'b', status: 'totally-made-up' },
        ],
      },
    ]);

    await migration.up();

    // The documented token is repaired; the unknown one is left exactly as found.
    expect(await statusesOf(id)).toEqual(['in_progress', 'totally-made-up']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('SKIPPED'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('totally-made-up'));
    warn.mockRestore();
  });

  it('does not spin forever on a plan it can only skip', async () => {
    // The regression that a self-consuming filter would cause: a doc holding an unknown token
    // still matches the selection filter after the pass, so _id-cursor pagination is what makes
    // this terminate. A hang here is the failure.
    await insertPlan([
      { id: 'q1', complexity: 'Medium', subQuests: [{ id: 'sq1', title: 'a', status: 'nope' }] },
    ]);

    await expect(migration.up()).resolves.toBeUndefined();
  });

  it('reports a clean collection explicitly rather than silently doing nothing', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await migration.up();

    // The run itself is the audit: on prod this line is the evidence that the retired
    // vocabularies never reached the collection.
    expect(log).toHaveBeenCalledWith(expect.stringContaining('already clean'));
    log.mockRestore();
  });

  it('never touches reviewStatus, where pending is canonical rather than retired', async () => {
    const id = await plans()
      .insertOne({
        notebookId: 'session1',
        goal: 'Review gate plan',
        state: 'active',
        quests: [
          {
            id: 'q1',
            title: 'Quest',
            description: 'd',
            complexity: 'Medium',
            subQuests: [
              { id: 'sq1', title: 'a', status: 'in-progress', reviewGate: true, reviewStatus: 'pending' },
            ],
          },
        ],
      })
      .then(r => r.insertedId);

    await migration.up();

    const doc = await plans().findOne({ _id: id });
    const subQuest = (doc!.quests as { subQuests: { status: string; reviewStatus: string }[] }[])[0].subQuests[0];
    // status repaired, reviewStatus untouched. Sharing a normalizer between the two would have
    // turned this gate into 'not_started' and destroyed it.
    expect(subQuest.status).toBe('in_progress');
    expect(subQuest.reviewStatus).toBe('pending');
  });

  it('repairs across many plans, including ones with nothing wrong', async () => {
    const dirty = await insertPlan([
      { id: 'q1', complexity: 'high', subQuests: [{ id: 'sq1', title: 'a', status: 'pending' }] },
    ]);
    const clean = await insertPlan([
      { id: 'q1', complexity: 'Easy', subQuests: [{ id: 'sq1', title: 'a', status: 'completed' }] },
    ]);
    const alsoDirty = await insertPlan([
      { id: 'q1', complexity: 'Medium', subQuests: [{ id: 'sq1', title: 'a', status: 'in-progress' }] },
    ]);

    await migration.up();

    expect(await statusesOf(dirty)).toEqual(['not_started']);
    expect(await complexitiesOf(dirty)).toEqual(['Hard']);
    expect(await statusesOf(clean)).toEqual(['completed']);
    expect(await statusesOf(alsoDirty)).toEqual(['in_progress']);
  });

  it('handles a plan with no quests and a quest with no subQuests without throwing', async () => {
    const empty = await plans()
      .insertOne({ notebookId: 's', goal: 'Empty', state: 'active', quests: [] })
      .then(r => r.insertedId);
    const noSubs = await insertPlan([{ id: 'q1', complexity: 'low', subQuests: [] }]);

    await expect(migration.up()).resolves.toBeUndefined();

    expect((await plans().findOne({ _id: empty }))!.quests).toEqual([]);
    expect(await complexitiesOf(noSubs)).toEqual(['Easy']);
  });

  it('leaves every value canonical after the run, by the same predicate the app uses', async () => {
    await insertPlan([
      {
        id: 'q1',
        complexity: 'medium',
        subQuests: [
          { id: 'sq1', title: 'a', status: 'in-progress' },
          { id: 'sq2', title: 'b', status: 'pending' },
          { id: 'sq3', title: 'c', status: 'blocked' },
          { id: 'sq4', title: 'd', status: 'skipped' },
        ],
      },
    ]);

    await migration.up();

    const remaining = await plans()
      .find({
        quests: { $elemMatch: { subQuests: { $elemMatch: { status: { $nin: [...SUBQUEST_STATUS_VALUES] } } } } },
      })
      .toArray();
    expect(remaining).toEqual([]);
  });
});
