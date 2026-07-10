import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { CreditHolderType } from '@bike4mind/common';
import { creditService } from '@bike4mind/services';
import {
  Project,
  FabFile,
  PublishedArtifact,
  agentRepository,
  dataLakeRepository,
  creditTransactionRepository,
  userRepository,
} from '@bike4mind/database';

/**
 * GET /api/gears/status — the Gears progression surface.
 *
 * A "gear" is a major feature whose sidenav presence is EARNED by first use
 * (the nav rail stays New Chat / Gears / Help until then). Unlock state is
 * DERIVED from data existence — "has ≥1 project" IS the unlock — so there is
 * no unlock table to migrate or drift, and users with existing data are
 * grandfathered automatically. Receipt counts as use: a project you were
 * added to unlocks Projects (the collaboration is the tutorial).
 *
 * First unlock of each gear grants a one-time credit reward. Idempotency
 * rides the credit ledger itself: the stable transactionId
 * `gear-unlock:<userId>:<gearKey>` is a unique key on CreditTransaction, so a
 * duplicate grant attempt is swallowed by addCredits — this endpoint can be
 * polled freely and can never double-credit.
 */

/** One-time reward per gear unlock; env-tunable without a deploy contract change. */
export const GEAR_UNLOCK_CREDITS = Number(process.env.GEAR_UNLOCK_CREDITS ?? 25);

export type GearKey = 'projects' | 'agents' | 'datalakes' | 'files' | 'published';

const gearTxId = (userId: string, key: GearKey) => `gear-unlock:${userId}:${key}`;

/** Derived existence checks — cheapest possible query per gear. */
const GEAR_CHECKS: Record<GearKey, (userId: string) => Promise<boolean>> = {
  // Owner OR member — same membership arms as the publish project-visibility gate.
  projects: async userId => !!(await Project.exists({ $or: [{ userId }, { 'users.id': userId }] })),
  agents: async userId => (await agentRepository.countByUserId(userId)) > 0,
  datalakes: async userId => !!(await dataLakeRepository.findOne({ createdByUserId: userId })),
  files: async userId => !!(await FabFile.exists({ userId })),
  published: async userId => !!(await PublishedArtifact.exists({ ownerId: userId, deletedAt: null })),
};

const GEAR_KEYS = Object.keys(GEAR_CHECKS) as GearKey[];

export interface GearStatus {
  key: GearKey;
  unlocked: boolean;
  /** Set only on the response that actually granted the reward. */
  creditsAwarded?: number;
}

const handler = baseApi().get(
  asyncHandler(async (req, res) => {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const unlockedFlags = await Promise.all(GEAR_KEYS.map(key => GEAR_CHECKS[key](String(userId))));

    // One indexed query tells us which unlocks were already rewarded, so the
    // common case (nothing new) never attempts a ledger write.
    const txIds = GEAR_KEYS.map(key => gearTxId(String(userId), key));
    const existing = await creditTransactionRepository.find({ transactionId: { $in: txIds } });
    const rewarded = new Set((existing as Array<{ transactionId?: string }>).map(t => t.transactionId).filter(Boolean));

    const gears: GearStatus[] = [];
    for (let i = 0; i < GEAR_KEYS.length; i++) {
      const key = GEAR_KEYS[i];
      const unlocked = unlockedFlags[i];
      const gear: GearStatus = { key, unlocked };
      if (unlocked && GEAR_UNLOCK_CREDITS > 0 && !rewarded.has(gearTxId(String(userId), key))) {
        try {
          const holder = await creditService.addCredits(
            {
              ownerId: String(userId),
              ownerType: CreditHolderType.User,
              credits: GEAR_UNLOCK_CREDITS,
              type: 'generic_add',
              transactionId: gearTxId(String(userId), key),
              reason: `gear unlock: ${key}`,
            },
            { db: { creditTransactions: creditTransactionRepository }, creditHolderMethods: userRepository }
          );
          // addCredits returns the holder on success; a raced duplicate is
          // swallowed inside (unique transactionId) and never double-credits.
          if (holder) gear.creditsAwarded = GEAR_UNLOCK_CREDITS;
        } catch (err) {
          // Reward failure must not break the status surface — the nav still
          // needs its answer. The stable transactionId makes any retry safe.
          req.logger?.warn?.({ err, key }, 'gear unlock credit grant failed');
        }
      }
      gears.push(gear);
    }

    return res.status(200).json({
      gears,
      totalUnlocked: gears.filter(g => g.unlocked).length,
      creditsPerUnlock: GEAR_UNLOCK_CREDITS,
    });
  })
);

export const config = {
  api: { externalResolver: true },
};

export default handler;
