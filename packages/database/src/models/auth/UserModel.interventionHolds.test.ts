import { describe, expect, it } from 'vitest';
import type { InterventionHold } from '@bike4mind/common';
import { User, userRepository } from './UserModel';
import { setupMongoTest } from '../../__test__/utils';

setupMongoTest();

const NOW = new Date('2026-11-24T10:00:00Z');
let seq = 0;

const createUser = async () => {
  seq += 1;
  const user = await User.create({ username: `hold${seq}`, name: 'Hold', email: `hold${seq}@example.com` });
  return user.id as string;
};

const hold = (decisionId: string, over: Partial<InterventionHold> = {}): InterventionHold => ({
  decisionId,
  detectionId: 'detection-1',
  tier: 'review',
  policyVersion: 1,
  reason: 'Automated review (policy v1)',
  appliedAt: NOW,
  expiresAt: new Date(NOW.getTime() + 72 * 60 * 60 * 1000),
  releasedAt: null,
  releasedBy: null,
  ...over,
});

const holdsOf = async (id: string) => (await User.findById(id).lean())?.interventionHolds ?? [];

describe('UserRepository intervention holds', () => {
  it('adds a hold once per decision, so a retried decision never applies twice', async () => {
    const id = await createUser();
    expect(await userRepository.addInterventionHold(id, hold('decision-1'))).toBe(true);
    expect(await userRepository.addInterventionHold(id, hold('decision-1'))).toBe(false);
    expect(await userRepository.addInterventionHold(id, hold('decision-2', { tier: 'limit' }))).toBe(true);
    expect((await holdsOf(id)).map(h => h.decisionId)).toEqual(['decision-1', 'decision-2']);
  });

  it('releases only that decision and leaves other holds, moderation and review state alone', async () => {
    const id = await createUser();
    await User.collection.updateOne(
      { _id: (await User.findById(id))!._id },
      {
        $set: {
          isModerated: true,
          signupGrantHeldReason: 'risk_review',
          riskScore: { score: 70, signals: [], computedAt: NOW, reviewState: 'pending' },
        },
      }
    );
    await userRepository.addInterventionHold(id, hold('decision-1'));
    await userRepository.addInterventionHold(id, hold('decision-2', { tier: 'holdGrant' }));

    expect(await userRepository.releaseInterventionHold(id, 'decision-1', { by: 'admin-1', now: NOW })).toBe(true);
    expect(await userRepository.releaseInterventionHold(id, 'decision-1', { by: 'admin-1', now: NOW })).toBe(false);
    expect(await userRepository.releaseInterventionHold(id, 'unknown', { by: 'admin-1', now: NOW })).toBe(false);

    const user = await User.findById(id).lean();
    expect(user?.interventionHolds?.map(h => [h.decisionId, h.releasedAt, h.releasedBy])).toEqual([
      ['decision-1', NOW, 'admin-1'],
      ['decision-2', null, null],
    ]);
    expect(user?.isModerated).toBe(true);
    expect(user?.signupGrantHeldReason).toBe('risk_review');
    expect(user?.riskScore?.reviewState).toBe('pending');
  });

  it('reports whether any account still carries an unreleased hold from a decision', async () => {
    const first = await createUser();
    const second = await createUser();
    await userRepository.addInterventionHold(first, hold('decision-shared'));
    await userRepository.addInterventionHold(second, hold('decision-shared'));

    await userRepository.releaseInterventionHold(first, 'decision-shared', { by: 'admin-1', now: NOW });
    expect(await userRepository.hasUnreleasedInterventionHold('decision-shared')).toBe(true);
    await userRepository.releaseInterventionHold(second, 'decision-shared', { by: 'admin-1', now: NOW });
    expect(await userRepository.hasUnreleasedInterventionHold('decision-shared')).toBe(false);
  });

  it('stamps only lapsed, unreleased holds expired and returns their decisions', async () => {
    const id = await createUser();
    const past = new Date(NOW.getTime() - 1000);
    await userRepository.addInterventionHold(id, hold('lapsed', { expiresAt: past }));
    await userRepository.addInterventionHold(id, hold('active'));
    await userRepository.addInterventionHold(id, hold('released', { expiresAt: past }));
    await userRepository.releaseInterventionHold(id, 'released', { by: 'admin-1', now: past });

    expect(await userRepository.expireInterventionHolds(NOW)).toEqual(['lapsed']);
    expect((await holdsOf(id)).map(h => [h.decisionId, h.releasedBy])).toEqual([
      ['lapsed', 'expiry'],
      ['active', null],
      ['released', 'admin-1'],
    ]);
    expect(await userRepository.expireInterventionHolds(NOW)).toEqual([]);
  });

  it('ignores an invalid user id', async () => {
    expect(await userRepository.addInterventionHold('not-an-id', hold('decision-1'))).toBe(false);
    expect(await userRepository.releaseInterventionHold('not-an-id', 'decision-1', { by: 'a', now: NOW })).toBe(false);
  });
});
