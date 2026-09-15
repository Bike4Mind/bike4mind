import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import { User, userRepository } from './UserModel';

/**
 * Real-MongoDB regression for the whole-document read-modify-write hazard in
 * BaseRepository.update. `userRepository` inherits `BaseRepository.update` unchanged,
 * so it exercises the exact primitive the call-site fixes rely on. currentCredits and
 * tokenVersion stand in for the atomic security/credit writes (credit deductions, the
 * session kill switch) that a concurrent whole-document $set was reverting.
 */

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;

const seed = () =>
  User.create({
    username: 'racer',
    name: 'Racer',
    email: 'racer@example.com',
    currentCredits: 100,
    tokenVersion: 0,
  });

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

describe('BaseRepository.update whole-document hazard (via userRepository)', () => {
  it('a TARGETED partial write preserves a concurrent credit deduction (the fix)', async () => {
    const u = await seed();
    const id = String(u._id);

    // A credit deduction lands in the read-to-write window.
    await userRepository.incrementCredits(id, -30);

    // The write persists ONLY the field the request changed.
    await userRepository.update({ id, name: 'Renamed' });

    const after = await User.findById(id);
    expect(after!.currentCredits).toBe(70); // survived
    expect(after!.name).toBe('Renamed');
  });

  it('a TARGETED partial write preserves a concurrent tokenVersion bump (session kill switch)', async () => {
    const u = await seed();
    const id = String(u._id);

    await userRepository.incrementTokenVersion(id); // forced logout -> tokenVersion 1

    await userRepository.update({ id, name: 'Renamed' });

    const after = await User.findById(id);
    expect(after!.tokenVersion).toBe(1); // kill switch survived
    expect(after!.name).toBe('Renamed');
  });

  it('a WHOLE-DOCUMENT snapshot write reverts a concurrent credit deduction (the hazard removed by the fix)', async () => {
    const u = await seed();
    const id = String(u._id);

    // A caller that read currentCredits=100 earlier still holds that stale value.
    const stale = { id, name: 'Racer', currentCredits: 100 };
    await userRepository.incrementCredits(id, -30); // concurrent deduction -> 70

    await userRepository.update(stale); // $set of the whole stale snapshot

    const after = await User.findById(id);
    expect(after!.currentCredits).toBe(100); // reverted - this is exactly the bug the call sites now avoid
  });

  it('a HYDRATED whole-document write also reverts a concurrent write (hydration is not a safety net)', async () => {
    const u = await seed();
    const id = String(u._id);

    // findUpdateAccessById (sessionService/update) returns a hydrated mongoose doc. Object-rest
    // spreads its schema fields just like a plain toJSON() snapshot, so passing it straight to
    // update() clobbers exactly the same way - the concurrent deduction is reverted. This is why
    // sessionService/update builds a targeted partial instead of writing the hydrated session.
    const hydrated = await User.findById(id); // snapshot, currentCredits=100
    await userRepository.incrementCredits(id, -30); // concurrent deduction -> 70

    await userRepository.update(hydrated as unknown as Parameters<typeof userRepository.update>[0]);

    const after = await User.findById(id);
    expect(after!.currentCredits).toBe(100); // reverted, identical to a plain snapshot
  });
});
