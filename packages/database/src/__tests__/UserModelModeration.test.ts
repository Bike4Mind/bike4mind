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

  it('sets throttled status with a throttledUntil deadline and does not mirror isModerated', async () => {
    const user = await User.create({ username: 'mod-4', name: 'Mod Four' });
    const until = new Date(Date.now() + 60_000);

    const updated = await userRepository.setModerationStatus(user.id, 'throttled', { throttledUntil: until });

    expect(updated?.moderation?.status).toBe('throttled');
    expect(updated?.moderation?.throttledUntil?.getTime()).toBe(until.getTime());
    expect(updated?.moderation?.statusChangedAt).toBeInstanceOf(Date);
    expect(updated?.isModerated).toBe(false);
  });

  it('mirrors isModerated=true when suspended and clears throttledUntil', async () => {
    const user = await User.create({ username: 'mod-5', name: 'Mod Five' });
    await userRepository.setModerationStatus(user.id, 'throttled', { throttledUntil: new Date(Date.now() + 60_000) });

    const updated = await userRepository.setModerationStatus(user.id, 'suspended');

    expect(updated?.moderation?.status).toBe('suspended');
    expect(updated?.moderation?.throttledUntil).toBeNull();
    expect(updated?.isModerated).toBe(true);
  });

  it('clears the isModerated mirror when a suspension is lifted back to active', async () => {
    const user = await User.create({ username: 'mod-6', name: 'Mod Six' });
    await userRepository.setModerationStatus(user.id, 'suspended');

    const updated = await userRepository.setModerationStatus(user.id, 'active');

    expect(updated?.moderation?.status).toBe('active');
    expect(updated?.isModerated).toBe(false);
  });

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
