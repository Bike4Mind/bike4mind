import mongoose, { type Model } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FeedbackStatus, PENDING_FREE_CREDITS_TAG } from '@bike4mind/common';
import { createMongoServer } from '../__test__/createMongoServer';
import { Subscriber, subscriberRepository } from '../models/auth/SubscriberModel';
import { User, userRepository } from '../models/auth/UserModel';
import { signupGrantReleaseRepository } from '../models/auth/SignupGrantReleaseBatchModel';
import { SignupDomainReviewModel, signupDomainHoldListRepository } from '../models/auth/SignupProtectionModel';
import {
  ImageModerationIncident,
  imageModerationIncidentRepository,
} from '../models/content/ImageModerationIncidentModel';
import { PublishedArtifact, publishedArtifactRepository } from '../models/content/PublishedArtifactModel';
import { StripeDisputeModel, stripeDisputeRepository } from '../models/billing/StripeDisputeModel';
import { ModelDiscoveryState, modelDiscoveryStateRepository } from '../models/ai/ModelDiscoveryStateModel';
import { AdminApprovalModel, adminApprovalRepository } from '../models/infra/admin/AdminApprovalModel';
import { SecretRotation, secretRotationRepository } from '../models/infra/security/SecretRotationModel';
import { SreErrorTrackingModel, sreErrorTrackingRepository } from '../models/infra/ops/SreErrorTrackingModel';
import { FeedbackModel, countNewFeedback, oldestNewFeedbackAt } from '../models/social/FeedbackModel';

// The admin sidebar's action counts (apps/client/server/admin/actionCounts.ts). Rows are inserted
// raw: only the stored shape the filters read matters, not each model's full validation.

const insertRaw = async (target: Model<never>, docs: Record<string, unknown>[]) => {
  await target.collection.insertMany(docs);
};
const raw = <T>(target: Model<T>) => target as unknown as Model<never>;

const NOW = new Date('2026-11-09T12:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;
const later = new Date(NOW.getTime() + HOUR_MS);
const earlier = new Date(NOW.getTime() - HOUR_MS);

describe('admin action count queries', () => {
  let server: Awaited<ReturnType<typeof createMongoServer>>;

  beforeAll(async () => {
    server = await createMongoServer();
    await mongoose.connect(server.getUri());
  });
  beforeEach(async () => {
    await Promise.all(Object.values(mongoose.connection.collections).map(collection => collection.deleteMany({})));
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await server?.stop();
  });

  it('countWaiting counts live subscribers with no invite yet, and stops at the limit', async () => {
    await insertRaw(raw(Subscriber), [
      { email: 'a@x.test', deletedAt: null },
      { email: 'b@x.test', deletedAt: null, inviteGenerated: false },
      { email: 'c@x.test', deletedAt: null, inviteGenerated: false },
      { email: 'd@x.test', deletedAt: null, inviteGenerated: true },
      { email: 'e@x.test', deletedAt: earlier },
    ]);

    expect(await subscriberRepository.countWaiting()).toBe(3);
    expect(await subscriberRepository.countWaiting({ limit: 2 })).toBe(2);
  });

  it('oldest readers exclude settled rows under the sidebar predicates', async () => {
    await insertRaw(raw(FeedbackModel), [
      { status: FeedbackStatus.New, createdAt: NOW },
      { status: FeedbackStatus.New, createdAt: earlier },
      { status: 'Resolved', createdAt: new Date(0) },
    ]);
    await insertRaw(raw(SignupDomainReviewModel), [
      { domain: 'pending.test', status: 'held_pending_review', triggeredAt: earlier },
      { domain: 'released.test', status: 'released', triggeredAt: new Date(0) },
    ]);
    await insertRaw(raw(ImageModerationIncident), [
      { reviewStatus: 'pending_review', createdAt: NOW },
      { reviewStatus: null, createdAt: earlier },
      { reviewStatus: 'confirmed', createdAt: new Date(0) },
    ]);
    expect(await oldestNewFeedbackAt()).toEqual(earlier);
    expect(await signupDomainHoldListRepository.oldestPendingAt()).toEqual(earlier);
    expect(await imageModerationIncidentRepository.oldestPendingReviewAt()).toEqual(earlier);
  });

  it('countHeld counts budget-held pending grants, and stops at the limit', async () => {
    await insertRaw(raw(User), [
      { username: 'h1', signupGrantHeldReason: 'budget_exhausted', tags: [PENDING_FREE_CREDITS_TAG] },
      { username: 'h2', signupGrantHeldReason: 'budget_exhausted', tags: [PENDING_FREE_CREDITS_TAG] },
      { username: 'h3', signupGrantHeldReason: 'budget_exhausted', tags: [] },
      { username: 'h4', tags: [PENDING_FREE_CREDITS_TAG] },
    ]);

    expect(await signupGrantReleaseRepository.countHeld()).toBe(2);
    expect(await signupGrantReleaseRepository.countHeld(undefined, { limit: 1 })).toBe(1);
  });

  it('countPendingRiskReviews counts unbanned pending reviews, and stops at the limit', async () => {
    await insertRaw(raw(User), [
      { username: 'r1', riskScore: { reviewState: 'pending' } },
      { username: 'r2', riskScore: { reviewState: 'pending' }, isBanned: false },
      { username: 'r3', riskScore: { reviewState: 'pending' }, isBanned: true },
      { username: 'r4', riskScore: { reviewState: 'approved' } },
    ]);

    expect(await userRepository.countPendingRiskReviews()).toBe(2);
    expect(await userRepository.countPendingRiskReviews({ limit: 1 })).toBe(1);
  });

  it('countPendingReview counts unreviewed moderation incidents, and stops at the limit', async () => {
    await insertRaw(raw(ImageModerationIncident), [
      { reviewStatus: 'pending_review' },
      { reviewStatus: null },
      { reviewStatus: 'confirmed' },
    ]);

    expect(await imageModerationIncidentRepository.countPendingReview()).toBe(2);
    expect(await imageModerationIncidentRepository.countPendingReview({ limit: 1 })).toBe(1);
  });

  it('countPending counts domain holds still awaiting review, and stops at the limit', async () => {
    await insertRaw(raw(SignupDomainReviewModel), [
      { domain: 'a.test', status: 'held_pending_review' },
      { domain: 'b.test', status: 'held_pending_review' },
      { domain: 'c.test', status: 'blocked' },
      { domain: 'd.test', status: 'released' },
    ]);

    expect(await signupDomainHoldListRepository.countPending()).toBe(2);
    expect(await signupDomainHoldListRepository.countPending({ limit: 1 })).toBe(1);
  });

  it('countReported counts live reported artifacts, and stops at the limit', async () => {
    await insertRaw(raw(PublishedArtifact), [
      { publicId: 'p1', slug: 'p1', moderationStatus: 'reported', deletedAt: null },
      { publicId: 'p2', slug: 'p2', moderationStatus: 'reported', deletedAt: null },
      { publicId: 'p3', slug: 'p3', moderationStatus: 'reported', deletedAt: earlier },
      { publicId: 'p4', slug: 'p4', moderationStatus: 'active', deletedAt: null },
    ]);

    expect(await publishedArtifactRepository.countReported()).toBe(2);
    expect(await publishedArtifactRepository.countReported({ limit: 1 })).toBe(1);
  });

  it('countAdminResolvable counts open disputes an admin may resolve, and stops at the limit', async () => {
    await insertRaw(raw(StripeDisputeModel), [
      { stripeDisputeId: 'd1', state: 'open', subject: 'organization', closedAt: null, stripeStatus: 'needs_response' },
      { stripeDisputeId: 'd2', state: 'open', subject: 'unmatched', closedAt: null, stripeStatus: 'needs_response' },
      // A user dispute Stripe closed without a won/lost verdict is admin-resolvable too.
      { stripeDisputeId: 'd3', state: 'open', subject: 'user', closedAt: earlier, stripeStatus: 'warning_closed' },
      { stripeDisputeId: 'd4', state: 'open', subject: 'user', closedAt: null, stripeStatus: 'needs_response' },
      { stripeDisputeId: 'd5', state: 'open', subject: 'user', closedAt: earlier, stripeStatus: 'lost' },
      { stripeDisputeId: 'd6', state: 'resolved', subject: 'organization', closedAt: null, stripeStatus: 'won' },
    ]);

    expect(await stripeDisputeRepository.countAdminResolvable()).toBe(3);
    expect(await stripeDisputeRepository.countAdminResolvable({ limit: 2 })).toBe(2);
  });

  it('countPendingSuggestions counts unresolved lifecycle suggestions, and stops at the limit', async () => {
    await insertRaw(raw(ModelDiscoveryState), [
      { modelId: 'm1', suggestion: { suggestedAt: earlier } },
      { modelId: 'm2', suggestion: { suggestedAt: earlier } },
      { modelId: 'm3', suggestion: { suggestedAt: earlier, resolution: 'accepted', resolvedAt: NOW } },
      { modelId: 'm4' },
    ]);

    expect(await modelDiscoveryStateRepository.countPendingSuggestions()).toBe(2);
    expect(await modelDiscoveryStateRepository.countPendingSuggestions({ limit: 1 })).toBe(1);
  });

  it('countOverdue counts active configured rotations past due, and stops at the limit', async () => {
    await insertRaw(raw(SecretRotation), [
      { keyName: 'A', isActive: true, nextRotation: earlier },
      { keyName: 'B', isActive: true, nextRotation: earlier },
      { keyName: 'C', isActive: true, nextRotation: later },
      { keyName: 'D', isActive: false, nextRotation: earlier },
      { keyName: 'REMOVED', isActive: true, nextRotation: earlier },
    ]);
    const keyNames = ['A', 'B', 'C', 'D'];

    expect(await secretRotationRepository.countOverdue({ now: NOW, keyNames })).toBe(2);
    expect(await secretRotationRepository.countOverdue({ now: NOW, keyNames, limit: 1 })).toBe(1);
  });

  it('countFailed counts failed and dispatch_failed pipelines, and stops at the limit', async () => {
    await insertRaw(raw(SreErrorTrackingModel), [
      { repoSlug: 'o/r', errorFingerprint: 'f1', status: 'failed' },
      { repoSlug: 'o/r', errorFingerprint: 'f2', status: 'dispatch_failed' },
      { repoSlug: 'o/r', errorFingerprint: 'f3', status: 'wont_fix' },
      { repoSlug: 'o/r', errorFingerprint: 'f4', status: 'fixed' },
    ]);

    expect(await sreErrorTrackingRepository.countFailed()).toBe(2);
    expect(await sreErrorTrackingRepository.countFailed({ limit: 1 })).toBe(1);
  });

  it('countNewFeedback counts New reports, and stops at the limit', async () => {
    await insertRaw(raw(FeedbackModel), [
      { userId: 'u1', status: FeedbackStatus.New },
      { userId: 'u2', status: FeedbackStatus.New },
      { userId: 'u3', status: 'Resolved' },
    ]);

    expect(await countNewFeedback()).toBe(2);
    expect(await countNewFeedback({ limit: 1 })).toBe(1);
  });

  describe('countDecidable', () => {
    const requester = (id: string, selfIds: string[] = [id]) => ({ id, name: id, email: `${id}@x.test`, selfIds });
    const approval = (overrides: Record<string, unknown>) => ({
      action: 'credits.grant',
      status: 'pending',
      expiresAt: later,
      requestedBy: requester('other'),
      requiredPermission: 'credits:adjust',
      requiresFullAdmin: false,
      ...overrides,
    });

    beforeEach(async () => {
      await insertRaw(raw(AdminApprovalModel), [
        approval({}),
        approval({ requiredPermission: 'users:delete' }),
        approval({ requiresFullAdmin: true }),
        approval({ requestedBy: requester('viewer') }),
        // Requested while impersonating: the real admin appears only in selfIds.
        approval({ requestedBy: requester('target', ['target', 'real-admin']) }),
        approval({ expiresAt: earlier }),
        approval({ status: 'approved' }),
      ]);
    });

    it('for a delegate counts only rows its permissions decide, never full-admin-only or its own', async () => {
      const count = await adminApprovalRepository.countDecidable({
        now: NOW,
        viewerIds: ['viewer'],
        permissions: ['support:read', 'credits:adjust'],
        fullAdmin: false,
      });
      // The live other-requester credits row and the one requested under impersonation by someone else.
      expect(count).toBe(2);
    });

    it('for a full admin includes full-admin-only rows and excludes the impersonating admin', async () => {
      const count = await adminApprovalRepository.countDecidable({
        now: NOW,
        viewerIds: ['target', 'real-admin'],
        permissions: ['credits:adjust', 'users:delete'],
        fullAdmin: true,
      });
      // credits, users:delete, full-admin-only, and the one requested by 'viewer'.
      expect(count).toBe(4);
    });

    it('stops at the limit', async () => {
      const count = await adminApprovalRepository.countDecidable({
        now: NOW,
        viewerIds: ['nobody'],
        permissions: ['credits:adjust', 'users:delete'],
        fullAdmin: true,
        limit: 2,
      });
      expect(count).toBe(2);
    });
  });
});
