import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import { AssistantInstructionModel, assistantInstructionRepository as repo } from './AssistantInstructionModel';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

afterEach(async () => {
  await AssistantInstructionModel.deleteMany({});
});

describe('assistantInstructionRepository', () => {
  it('lists only the owner instructions, oldest first, and counts them', async () => {
    await repo.create({ userId: 'u1', text: 'first' });
    await repo.create({ userId: 'u2', text: 'someone else' });
    await repo.create({ userId: 'u1', text: 'second' });

    const listed = await repo.listByUser('u1');
    expect(listed.map(i => i.text)).toEqual(['first', 'second']);
    expect(await repo.countByUser('u1')).toBe(2);
    expect(await repo.countByUser('nobody')).toBe(0);
  });

  it('deletes an owned instruction and reports it', async () => {
    const created = await repo.create({ userId: 'u1', text: 'drop me' });
    expect(await repo.deleteOwned('u1', created._id.toString())).toBe(true);
    expect(await repo.countByUser('u1')).toBe(0);
  });

  it('leaves another user instruction in place and reports it missing', async () => {
    const created = await repo.create({ userId: 'u1', text: 'mine' });
    expect(await repo.deleteOwned('u2', created._id.toString())).toBe(false);
    expect(await repo.countByUser('u1')).toBe(1);
  });

  it('treats a malformed or unknown id as missing without throwing', async () => {
    expect(await repo.deleteOwned('u1', 'not-an-id')).toBe(false);
    expect(await repo.deleteOwned('u1', new mongoose.Types.ObjectId().toString())).toBe(false);
  });

  it('refuses a save at the cap and lists every stored row', async () => {
    for (let i = 0; i < 3; i++)
      expect(await repo.createWithinCap({ userId: 'u1', text: `rule-${i}` }, 3)).not.toBeNull();
    expect(await repo.createWithinCap({ userId: 'u1', text: 'one more' }, 3)).toBeNull();
    expect(await repo.createWithinCap({ userId: 'u2', text: 'other user' }, 3)).not.toBeNull();
    expect((await repo.listByUser('u1')).map(i => i.text)).toEqual(['rule-0', 'rule-1', 'rule-2']);
  });

  it('never leaves more than the cap when saves race at the boundary', async () => {
    for (let i = 0; i < 19; i++) await repo.create({ userId: 'u1', text: `rule-${i}` });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => repo.createWithinCap({ userId: 'u1', text: `race-${i}` }, 20))
    );
    const count = await repo.countByUser('u1');
    expect(count).toBeLessThanOrEqual(20);
    expect(count).toBe(19 + results.filter(Boolean).length);
    expect(await repo.listByUser('u1')).toHaveLength(count);
  });

  it('rejects text over the length cap at the model', async () => {
    await expect(repo.create({ userId: 'u1', text: 'x'.repeat(281) })).rejects.toThrow();
  });
});
