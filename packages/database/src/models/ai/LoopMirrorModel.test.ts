import { describe, expect, it } from 'vitest';
import type { LoopMirrorSnapshot } from '@bike4mind/common/loops';
import { setupMongoTest } from '../../__test__/utils';
import { LoopMirror, loopMirrorRepository } from './LoopMirrorModel';

const snapshot = (name: string): LoopMirrorSnapshot => ({
  name,
  status: 'live',
  stages: ['todo'],
  lanesBusy: 0,
  lanes: 1,
  spentToday: 0,
  needsYou: 0,
  tickets: [],
});

describe('LoopMirrorRepository', () => {
  setupMongoTest();

  it('keeps one row per user and loop, the last post winning', async () => {
    await loopMirrorRepository.upsert('u1', 'l1', snapshot('First'), new Date('2026-11-16T10:00:00Z'));
    await loopMirrorRepository.upsert('u1', 'l1', snapshot('Second'), new Date('2026-11-16T10:02:00Z'));
    await loopMirrorRepository.upsert('u1', 'l2', snapshot('Other'), new Date('2026-11-16T10:01:00Z'));
    await loopMirrorRepository.upsert('u2', 'l1', snapshot('Not mine'), new Date('2026-11-16T10:03:00Z'));

    const mine = await loopMirrorRepository.listForUser('u1');
    expect(mine.map(row => row.snapshot.name)).toEqual(['Second', 'Other']);
    expect(mine[0].lastSeenAt.toISOString()).toBe('2026-11-16T10:02:00.000Z');
    expect(await loopMirrorRepository.countForUser('u1')).toBe(2);
    expect(await loopMirrorRepository.exists('u1', 'l1')).toBe(true);
  });

  it('refuses a second row for the same user and loop at the database', async () => {
    await LoopMirror.syncIndexes();
    const row = { userId: 'u1', localLoopId: 'l1', snapshot: snapshot('a'), lastSeenAt: new Date() };
    await LoopMirror.create(row);
    await expect(LoopMirror.create(row)).rejects.toThrow(/duplicate key/);
  });

  it('removes only the named loop', async () => {
    await loopMirrorRepository.upsert('u1', 'l1', snapshot('a'), new Date());
    await loopMirrorRepository.upsert('u1', 'l2', snapshot('b'), new Date());
    await loopMirrorRepository.remove('u1', 'l1');
    expect((await loopMirrorRepository.listForUser('u1')).map(row => row.localLoopId)).toEqual(['l2']);
  });
});
