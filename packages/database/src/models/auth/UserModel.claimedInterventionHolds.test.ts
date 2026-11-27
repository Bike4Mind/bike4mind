import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { InterventionHold } from '@bike4mind/common';
import { createMongoReplSet, settleAutoIndexBuilds } from '../../__test__/createMongoServer';
import { User, userRepository } from './UserModel';
import { ShadowDetectionModel } from '../infra/security/ShadowDetectionModel';
import {
  AutoContainmentDecisionModel,
  autoContainmentDecisionRepository as decisions,
} from '../infra/security/AutoContainmentDecisionModel';

const NOW = new Date('2026-11-24T10:00:00Z');
let server: Awaited<ReturnType<typeof createMongoReplSet>>;

beforeAll(async () => {
  server = await createMongoReplSet();
  await mongoose.connect(server.getUri(), { autoIndex: false, monitorCommands: true });
  await User.createCollection();
  await ShadowDetectionModel.createCollection();
  await AutoContainmentDecisionModel.createIndexes();
  await settleAutoIndexBuilds(mongoose);
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});
beforeEach(async () => {
  vi.restoreAllMocks();
  await User.deleteMany({});
  await AutoContainmentDecisionModel.deleteMany({});
  await ShadowDetectionModel.deleteMany({});
});

async function setup() {
  const users = await User.create([
    { username: 'first', name: 'First', email: 'first@example.com' },
    { username: 'second', name: 'Second', email: 'second@example.com' },
  ]);
  const userIds = users.map(user => user._id.toString());
  const detection = await ShadowDetectionModel.create({
    detector: 'youngAccountSpend',
    policyVersion: 1,
    wouldAction: 'contain',
    summary: 'Synthetic detection',
    userIds,
    detectedAt: NOW,
  });
  const decision = await decisions.recordOnce({
    detectionId: detection.id as string,
    revision: 0,
    assessmentId: 'assessment',
    mode: 'enforce',
    outcome: 'pending',
    tier: 'review',
    scope: 'ai_spend',
    policyVersion: 1,
    userIds,
    confidence: 0.97,
    reason: 'Automated review',
    batchId: null,
    error: null,
    decidedAt: NOW,
    expiresAt: new Date(NOW.getTime() + 72 * 3_600_000),
  });
  if (!decision) throw new Error('Expected a fresh decision');
  const hold: InterventionHold = {
    decisionId: decision.id,
    detectionId: decision.detectionId,
    tier: 'review',
    policyVersion: 1,
    reason: decision.reason,
    appliedAt: NOW,
    expiresAt: decision.expiresAt!,
    releasedAt: null,
    releasedBy: null,
  };
  return { userIds, decision, hold };
}

const release = { by: 'system:auto-containment', now: NOW };
const holdsOf = async (id: string) => (await User.findById(id).lean())?.interventionHolds ?? [];
const deferred = () => {
  let resolve: () => void = () => {
    throw new Error('Deferred not initialized');
  };
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
};

// Resolves when the competing write has actually been sent, before it can wait for the row lock.
function nextDecisionWrite(containment: boolean) {
  const started = deferred();
  const client = mongoose.connection.getClient();
  const listener = (event: { commandName: string; command: Record<string, unknown> }) => {
    if (event.commandName !== 'update' || event.command.update !== 'AutoContainmentDecision') return;
    const updates = event.command.updates;
    if (!Array.isArray(updates)) return;
    const update: unknown = updates[0];
    if (!update || typeof update !== 'object' || !('u' in update)) return;
    const body = update.u;
    if (!body || typeof body !== 'object' || !('$inc' in body)) return;
    if ('$addToSet' in body !== containment) return;
    client.off('commandStarted', listener);
    started.resolve();
  };
  client.on('commandStarted', listener);
  return started.promise;
}

describe('claimed graduated holds and committed containment', () => {
  it('keeps a partial receipt across unsuspend and accumulates the remaining account before final release', async () => {
    const {
      userIds: [first, second],
      decision,
      hold,
    } = await setup();
    await User.updateOne({ _id: first }, { $set: { isBanned: true } });
    await userRepository.releaseContainedInterventionHolds(decision.id, [first, 'outside-cohort'], release);
    expect(await decisions.findById(decision.id)).toMatchObject({
      outcome: 'pending',
      releasedAt: null,
      tier: 'review',
    });
    await User.updateOne({ _id: first }, { $set: { isBanned: false } });
    // First has never carried the hold: deduplication cannot substitute for the committed receipt guard.
    expect(await userRepository.addClaimedInterventionHold(first, hold, NOW)).toBe(false);
    expect(await holdsOf(first)).toEqual([]);
    expect(await userRepository.addClaimedInterventionHold(second, hold, NOW)).toBe(true);
    await User.updateOne({ _id: second }, { $set: { isBanned: true } });
    await userRepository.releaseContainedInterventionHolds(decision.id, [second], release);
    expect(await decisions.findById(decision.id)).toMatchObject({
      outcome: 'released',
      releaseCondition: 'contained',
      releasedAt: NOW,
      tier: 'review',
      policyVersion: 1,
      expiresAt: hold.expiresAt,
    });
    expect(await holdsOf(second)).toMatchObject([{ decisionId: decision.id, releasedAt: NOW, releasedBy: release.by }]);
    expect(await userRepository.addClaimedInterventionHold(first, hold, NOW)).toBe(false);
    const raw = await AutoContainmentDecisionModel.findById(decision.id).lean();
    expect(raw?.containedUserIds?.sort()).toEqual([first, second].sort());
  });

  it('preserves the remaining original hold and permits its normal admin release', async () => {
    const {
      userIds: [first, second],
      decision,
      hold,
    } = await setup();
    await userRepository.addClaimedInterventionHold(first, hold, NOW);
    await userRepository.addClaimedInterventionHold(second, hold, NOW);
    await decisions.finish(decision.id, { outcome: 'intervened', batchId: null, error: null }, NOW);
    await userRepository.releaseContainedInterventionHolds(decision.id, [first], release);
    expect(await holdsOf(first)).toMatchObject([{ releasedAt: NOW }]);
    expect(await holdsOf(second)).toMatchObject([{ releasedAt: null }]);
    expect(await decisions.findById(decision.id)).toMatchObject({ outcome: 'intervened', releasedAt: null });
    await userRepository.releaseInterventionHold(second, decision.id, { by: 'admin', now: NOW });
    await decisions.release(decision.id, { by: 'admin', now: NOW, reason: 'cleared', condition: 'admin_release' });
    await userRepository.releaseContainedInterventionHolds(decision.id, [second], release);
    expect(await decisions.findById(decision.id)).toMatchObject({
      releaseCondition: 'admin_release',
      releasedBy: 'admin',
    });
  });

  it('preserves a partial capped receipt when the remaining graduated claim is reclaimed', async () => {
    const {
      userIds: [first, second],
      decision,
      hold,
    } = await setup();
    await decisions.finish(decision.id, { outcome: 'capped', batchId: null, error: null }, NOW);
    await userRepository.releaseContainedInterventionHolds(decision.id, [first], release);
    const later = new Date(NOW.getTime() + 2 * 3_600_000);
    expect(
      await decisions.reclaim(decision.id, { now: later, staleBefore: later, cappedBefore: later, mode: 'enforce' })
    ).not.toBeNull();
    expect(await userRepository.addClaimedInterventionHold(first, hold, later)).toBe(false);
    expect(await userRepository.addClaimedInterventionHold(second, hold, later)).toBe(true);
    await userRepository.releaseContainedInterventionHolds(decision.id, [second], release);
    expect(
      await decisions.reclaim(decision.id, { now: later, staleBefore: later, cappedBefore: later, mode: 'enforce' })
    ).toBeNull();
  });

  it('accumulates simultaneous account receipts without losing either account', async () => {
    const {
      userIds: [first, second],
      decision,
      hold,
    } = await setup();
    await userRepository.addClaimedInterventionHold(first, hold, NOW);
    await userRepository.addClaimedInterventionHold(second, hold, NOW);
    await Promise.all([
      userRepository.releaseContainedInterventionHolds(decision.id, [first], release),
      userRepository.releaseContainedInterventionHolds(decision.id, [second], release),
    ]);
    expect(await decisions.findById(decision.id)).toMatchObject({ outcome: 'released', releaseCondition: 'contained' });
    expect(await holdsOf(first)).toMatchObject([{ releasedAt: NOW }]);
    expect(await holdsOf(second)).toMatchObject([{ releasedAt: NOW }]);
  });

  it('rolls back the receipt when releasing its account hold fails', async () => {
    const {
      userIds: [first],
      decision,
      hold,
    } = await setup();
    await userRepository.addClaimedInterventionHold(first, hold, NOW);
    vi.spyOn(userRepository, 'releaseInterventionHold').mockRejectedValueOnce(new Error('release unavailable'));
    await expect(userRepository.releaseContainedInterventionHolds(decision.id, [first], release)).rejects.toThrow(
      'release unavailable'
    );
    expect(await holdsOf(first)).toMatchObject([{ releasedAt: null }]);
    expect(await AutoContainmentDecisionModel.findById(decision.id).lean()).toMatchObject({
      outcome: 'pending',
      containedUserIds: [],
    });
  });

  it('excludes full admins and suspended users at the atomic sink', async () => {
    const {
      userIds: [first, second],
      hold,
    } = await setup();
    await User.updateOne({ _id: first }, { $set: { isAdmin: true } });
    await User.updateOne({ _id: second }, { $set: { isBanned: true } });
    expect(await userRepository.addClaimedInterventionHold(first, hold, NOW)).toBe(false);
    expect(await userRepository.addClaimedInterventionHold(second, hold, NOW)).toBe(false);
    expect(await holdsOf(first)).toEqual([]);
    expect(await holdsOf(second)).toEqual([]);
  });

  it('rejects writes from a reclaimed attempt', async () => {
    const {
      userIds: [first],
      decision,
      hold,
    } = await setup();
    const later = new Date(NOW.getTime() + 20 * 60_000);
    await decisions.reclaim(decision.id, { now: later, staleBefore: later, cappedBefore: NOW, mode: 'enforce' });
    expect(await userRepository.addClaimedInterventionHold(first, hold, NOW)).toBe(false);
    expect(await userRepository.addClaimedInterventionHold(first, hold, later)).toBe(true);
  });

  it('releases an application that commits while containment waits on its decision write', async () => {
    const {
      userIds: [first, second],
      decision,
      hold,
    } = await setup();
    const entered = deferred();
    const resume = deferred();
    const original = userRepository.addInterventionHold.bind(userRepository);
    vi.spyOn(userRepository, 'addInterventionHold').mockImplementationOnce(async (...args) => {
      entered.resolve();
      await resume.promise;
      return original(...args);
    });
    const applying = userRepository.addClaimedInterventionHold(first, hold, NOW);
    await entered.promise;
    const competingWrite = nextDecisionWrite(true);
    const containing = userRepository.releaseContainedInterventionHolds(decision.id, [first, second], release);
    await competingWrite;
    resume.resolve();
    expect(await applying).toBe(true);
    await containing;
    expect(await holdsOf(first)).toMatchObject([{ releasedAt: NOW }]);
    expect(await decisions.findById(decision.id)).toMatchObject({ outcome: 'released' });
  });

  it('refuses an application that waited behind a committed release', async () => {
    const {
      userIds: [first, second],
      decision,
      hold,
    } = await setup();
    const entered = deferred();
    const resume = deferred();
    const original = userRepository.releaseInterventionHold.bind(userRepository);
    vi.spyOn(userRepository, 'releaseInterventionHold').mockImplementationOnce(async (...args) => {
      entered.resolve();
      await resume.promise;
      return original(...args);
    });
    const containing = userRepository.releaseContainedInterventionHolds(decision.id, [first, second], release);
    await entered.promise;
    const competingWrite = nextDecisionWrite(false);
    const applying = userRepository.addClaimedInterventionHold(first, hold, NOW);
    await competingWrite;
    resume.resolve();
    await containing;
    expect(await applying).toBe(false);
    expect(await holdsOf(first)).toEqual([]);
    expect(await decisions.findById(decision.id)).toMatchObject({ outcome: 'released' });
  });
});
