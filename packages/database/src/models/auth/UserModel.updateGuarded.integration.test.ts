import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import { User, userRepository } from './UserModel';

/**
 * Real-MongoDB regression for the opt-in version guard. `update` is last-writer-wins (see
 * UserModel.repositoryUpdate.integration.test.ts); `updateGuarded` is the opt-in optimistic-
 * concurrency variant. Pins the two behaviours the PR review turned on:
 *  - `update` no longer throws when the SAME read-back doc (which carries __v) is saved twice - the
 *    deterministic ConcurrencyConflictError that broke quest final-save and research-task completion.
 *  - `updateGuarded` throws ConcurrencyConflictError on a stale write and succeeds when the caller
 *    adopts the returned (version-bumped) doc between writes.
 */

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;

const seed = () => User.create({ username: 'racer', name: 'Racer', email: 'racer@example.com', currentCredits: 100 });

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

afterEach(async () => {
  await User.deleteMany({});
});

describe('BaseRepository.update vs updateGuarded (via userRepository)', () => {
  it('update saves the same read-back doc twice without throwing (the broken-caller class)', async () => {
    const u = await seed();
    const id = String(u._id);

    const doc = await userRepository.findById(id); // a read-back doc retains __v
    expect(typeof (doc as unknown as { __v: unknown }).__v).toBe('number');

    // Both saves of the same in-memory doc succeed - plain $set, no version precondition. Before the
    // fix the second save carried a stale __v and threw ConcurrencyConflictError deterministically.
    await expect(userRepository.update({ ...doc!, name: 'first' })).resolves.toBeTruthy();
    await expect(userRepository.update({ ...doc!, name: 'second' })).resolves.toBeTruthy();

    const after = await User.findById(id);
    expect(after!.name).toBe('second');
  });

  it('updateGuarded throws ConcurrencyConflictError on a stale write and preserves the winner', async () => {
    const u = await seed();
    const id = String(u._id);

    const stale = await userRepository.findById(id); // __v 0
    const fresh = await userRepository.findById(id); // __v 0

    await userRepository.updateGuarded({ ...fresh!, name: 'winner' }); // __v 0 -> 1

    await expect(userRepository.updateGuarded({ ...stale!, name: 'loser' })).rejects.toThrow(/Concurrent modification/);

    const after = await User.findById(id);
    expect(after!.name).toBe('winner'); // the racing writer's value is not clobbered
  });

  it('a plain update does not rewind __v, so a racing guarded write still conflicts', async () => {
    const u = await seed();
    const id = String(u._id);

    const stale = await userRepository.findById(id); // __v 0

    // A guarded write advances the stored __v to 1.
    await userRepository.updateGuarded({ ...stale!, name: 'winner' }); // __v 0 -> 1

    // A plain whole-doc write from the __v-0 copy must NOT $set __v back to 0. Before the fix it
    // rewound the counter, re-arming the stale guarded write below.
    await userRepository.update({ ...stale!, name: 'plain' }); // carries __v 0
    const afterPlain = await User.findById(id);
    expect((afterPlain as unknown as { __v: number }).__v).toBe(1);

    // The stale guarded write (still holding __v 0) therefore loses the race and throws.
    await expect(userRepository.updateGuarded({ ...stale!, name: 'loser' })).rejects.toThrow(/Concurrent modification/);
  });

  it('updateGuarded succeeds when the caller adopts the returned version-bumped doc', async () => {
    const u = await seed();
    const id = String(u._id);

    const doc = await userRepository.findById(id); // __v 0
    const r1 = await userRepository.updateGuarded({ ...doc!, name: 'a' }); // __v 0 -> 1
    const r2 = await userRepository.updateGuarded({ ...r1!, name: 'b' }); // adopts __v 1 -> 2

    expect(r2!.name).toBe('b');
    const after = await User.findById(id);
    expect((after as unknown as { __v: number }).__v).toBe(2);
  });
});
