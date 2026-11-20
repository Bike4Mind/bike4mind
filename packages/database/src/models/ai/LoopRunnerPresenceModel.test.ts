import { describe, it, expect } from 'vitest';
import { setupMongoTest } from '../../__test__/utils';
import { loopRunnerPresenceRepository } from './LoopRunnerPresenceModel';

describe('LoopRunnerPresenceRepository', () => {
  setupMongoTest();

  it('keeps one row per user, the last post winning, and clears an unset waiting reason', async () => {
    const seenAt = new Date('2026-11-04T12:00:00Z');
    await loopRunnerPresenceRepository.upsertForUser('user-1', {
      seenAt,
      lanesBusy: 1,
      lanesFree: 3,
      waitingReason: 'Repo not cloned',
    });
    await loopRunnerPresenceRepository.upsertForUser('user-1', { seenAt, lanesBusy: 2, lanesFree: 2 });

    const presence = await loopRunnerPresenceRepository.findByUserId('user-1');
    expect(presence).toMatchObject({ userId: 'user-1', lanesBusy: 2, lanesFree: 2 });
    expect(presence?.waitingReason).toBeUndefined();
    expect(await loopRunnerPresenceRepository.findByUserId('user-2')).toBeNull();
  });
});
