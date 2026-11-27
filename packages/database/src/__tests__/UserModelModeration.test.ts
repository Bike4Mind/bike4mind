import { describe, it, expect } from 'vitest';
import { User, userRepository, MODERATION_HITS_RETAINED } from '../models/auth/UserModel';
import { setupMongoTest } from '../__test__/utils';
import type { IModerationHit } from '@bike4mind/common';

setupMongoTest();

const hit = (overrides: Partial<IModerationHit> = {}): IModerationHit => ({
  at: new Date(),
  categories: ['hate'],
  source: 'openai',
  ...overrides,
});

describe('UserModel — moderation hit tracking', () => {
  it('lazily creates the moderation subdocument on the first hit', async () => {
    const user = await User.create({ username: 'mod-1', name: 'Mod One' });
    expect(user.moderation).toBeUndefined();

    const updated = await userRepository.recordModerationHit(
      user.id,
      hit({ categories: ['violence'], questId: 'q-1' })
    );

    expect(updated?.moderation?.hitCount).toBe(1);
    expect(updated?.moderation?.hits).toHaveLength(1);
    expect(updated?.moderation?.hits[0]).toMatchObject({ categories: ['violence'], source: 'openai', questId: 'q-1' });
    expect(updated?.moderation?.lastHitAt).toBeInstanceOf(Date);
  });

  it('accumulates hits newest-first and increments the counter', async () => {
    const user = await User.create({ username: 'mod-2', name: 'Mod Two' });
    await userRepository.recordModerationHit(user.id, hit({ categories: ['a'] }));
    const updated = await userRepository.recordModerationHit(user.id, hit({ categories: ['b'] }));

    expect(updated?.moderation?.hitCount).toBe(2);
    expect(updated?.moderation?.hits).toHaveLength(2);
    // $position: 0 keeps the log newest-first.
    expect(updated?.moderation?.hits[0].categories).toEqual(['b']);
    expect(updated?.moderation?.hits[1].categories).toEqual(['a']);
  });

  it('caps the retained hit log at MODERATION_HITS_RETAINED while still counting lifetime hits', async () => {
    const user = await User.create({ username: 'mod-3', name: 'Mod Three' });
    for (let i = 0; i < MODERATION_HITS_RETAINED + 5; i++) {
      await userRepository.recordModerationHit(user.id, hit({ categories: [`c${i}`] }));
    }
    const reloaded = await User.findById(user.id);

    expect(reloaded?.moderation?.hitCount).toBe(MODERATION_HITS_RETAINED + 5);
    expect(reloaded?.moderation?.hits).toHaveLength(MODERATION_HITS_RETAINED);
    // Newest hit is retained; the oldest were sliced off.
    expect(reloaded?.moderation?.hits[0].categories).toEqual([`c${MODERATION_HITS_RETAINED + 4}`]);
  });

  it('sets throttled status with a throttledUntil deadline and leaves isModerated unset', async () => {
    const user = await User.create({ username: 'mod-4', name: 'Mod Four' });
    const until = new Date(Date.now() + 60_000);

    const updated = await userRepository.setModerationStatus(user.id, 'throttled', { throttledUntil: until });

    expect(updated?.moderation?.status).toBe('throttled');
    expect(updated?.moderation?.throttledUntil?.getTime()).toBe(until.getTime());
    expect(updated?.moderation?.statusChangedAt).toBeInstanceOf(Date);
    expect(updated?.isModerated).toBe(false);
  });

  it('leaves statusChangedAt alone on an automatic transition', async () => {
    const user = await User.create({ username: 'mod-auto', name: 'Mod Auto' });

    const updated = await userRepository.setModerationStatus(user.id, 'suspend_pending', { automatic: true });

    expect(updated?.moderation?.status).toBe('suspend_pending');
    expect(updated?.moderation?.statusChangedAt).toBeNull();
  });

  it('clears throttledUntil when suspended without setting isModerated', async () => {
    const user = await User.create({ username: 'mod-5', name: 'Mod Five' });
    await userRepository.setModerationStatus(user.id, 'throttled', { throttledUntil: new Date(Date.now() + 60_000) });

    const updated = await userRepository.setModerationStatus(user.id, 'suspended');

    expect(updated?.moderation?.status).toBe('suspended');
    expect(updated?.moderation?.throttledUntil).toBeNull();
    expect(updated?.isModerated).toBe(false);
  });

  it.each(['throttled', 'active', 'suspended'] as const)(
    'leaves an admin-set isModerated in place across a %s transition',
    async status => {
      const user = await User.create({ username: `mod-6-${status}`, name: 'Mod Six', isModerated: true });

      const updated = await userRepository.setModerationStatus(user.id, status);

      expect(updated?.moderation?.status).toBe(status);
      expect(updated?.isModerated).toBe(true);
    }
  );

  it('records a moderation appeal with a timestamp and text', async () => {
    const user = await User.create({ username: 'mod-7', name: 'Mod Seven' });
    await userRepository.setModerationStatus(user.id, 'suspended');

    const updated = await userRepository.recordModerationAppeal(user.id, 'I believe this was a mistake');

    expect(updated?.moderation?.appealedAt).toBeInstanceOf(Date);
    expect(updated?.moderation?.appealText).toBe('I believe this was a mistake');
    // Appealing does not itself change the escalation status - an admin resolves it.
    expect(updated?.moderation?.status).toBe('suspended');
  });
});

describe('UserModel - findModerationReviewQueue', () => {
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

  it('lists users awaiting a decision and users with an unreviewed severe hit, most recent hit first', async () => {
    const throttled = await User.create({ username: 'rq-throttled', name: 'Throttled' });
    await userRepository.recordModerationHit(throttled.id, hit({ at: minutesAgo(30) }));
    await userRepository.setModerationStatus(throttled.id, 'throttled', { throttledUntil: minutesAgo(-60) });

    const pending = await User.create({ username: 'rq-pending', name: 'Pending' });
    await userRepository.recordModerationHit(pending.id, hit({ at: minutesAgo(10) }));
    await userRepository.setModerationStatus(pending.id, 'suspend_pending');

    const severe = await User.create({ username: 'rq-severe', name: 'Severe' });
    await userRepository.recordModerationHit(
      severe.id,
      hit({ at: minutesAgo(5), categories: ['sexual', 'sexual/minors'] })
    );

    const ordinary = await User.create({ username: 'rq-ordinary', name: 'Ordinary' });
    await userRepository.recordModerationHit(ordinary.id, hit({ at: minutesAgo(1) }));
    await User.create({ username: 'rq-clean', name: 'Clean' });

    const queue = await userRepository.findModerationReviewQueue(10);

    expect(queue.map(row => row.id)).toEqual([severe.id, pending.id, throttled.id]);
    expect(queue[0]).toMatchObject({ name: 'Severe', hasUnreviewedSevereHit: true });
    expect(queue[1]).toMatchObject({ hasUnreviewedSevereHit: false });
    expect(queue[1].moderation.status).toBe('suspend_pending');
  });

  it('drops a severe-hit user once an admin acts after the hit, and lists them again on a newer one', async () => {
    const user = await User.create({ username: 'rq-reviewed', name: 'Reviewed' });
    await userRepository.recordModerationHit(user.id, hit({ at: minutesAgo(5), categories: ['sexual/minors'] }));
    await userRepository.setModerationStatus(user.id, 'active');

    expect(await userRepository.findModerationReviewQueue(10)).toEqual([]);

    await userRepository.recordModerationHit(
      user.id,
      hit({ at: new Date(Date.now() + 1000), categories: ['sexual/minors'] })
    );
    expect((await userRepository.findModerationReviewQueue(10)).map(row => row.id)).toEqual([user.id]);
  });

  it('does not list a suspended user without a newer severe hit', async () => {
    const user = await User.create({ username: 'rq-suspended', name: 'Suspended' });
    await userRepository.recordModerationHit(user.id, hit({ at: minutesAgo(5) }));
    await userRepository.setModerationStatus(user.id, 'suspended');

    expect(await userRepository.findModerationReviewQueue(10)).toEqual([]);
  });

  it('still flags a severe hit that triggered an automatic escalation', async () => {
    const user = await User.create({ username: 'rq-auto', name: 'Auto' });
    await userRepository.recordModerationHit(user.id, hit({ at: minutesAgo(1), categories: ['sexual/minors'] }));
    await userRepository.setModerationStatus(user.id, 'suspend_pending', { automatic: true });

    const queue = await userRepository.findModerationReviewQueue(10);

    expect(queue).toHaveLength(1);
    expect(queue[0].hasUnreviewedSevereHit).toBe(true);
  });

  it('returns the most recent hits first and honours the limit', async () => {
    const ids: string[] = [];
    for (const [index, age] of [30, 20, 10].entries()) {
      const user = await User.create({ username: `rq-limit-${index}`, name: `Limit ${index}` });
      await userRepository.recordModerationHit(user.id, hit({ at: minutesAgo(age) }));
      await userRepository.setModerationStatus(user.id, 'throttled', { throttledUntil: minutesAgo(-60) });
      ids.push(user.id);
    }

    const queue = await userRepository.findModerationReviewQueue(2);

    expect(queue.map(row => row.id)).toEqual([ids[2], ids[1]]);
  });

  it('counts the same users the list shows, up to the limit', async () => {
    for (const index of [0, 1, 2]) {
      const user = await User.create({ username: `rq-count-${index}`, name: `Count ${index}` });
      await userRepository.recordModerationHit(user.id, hit({ at: minutesAgo(5) }));
      await userRepository.setModerationStatus(user.id, 'suspend_pending');
    }
    const quiet = await User.create({ username: 'rq-count-quiet', name: 'Quiet' });
    await userRepository.recordModerationHit(quiet.id, hit({ at: minutesAgo(1) }));

    expect(await userRepository.countModerationReviewQueue()).toBe(3);
    expect(await userRepository.countModerationReviewQueue({ limit: 2 })).toBe(2);
  });
});
