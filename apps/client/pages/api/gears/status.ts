import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { CreditHolderType } from '@bike4mind/common';
import { creditService } from '@bike4mind/services';
import {
  Project,
  FabFile,
  PublishedArtifact,
  Artifact,
  ApiKey,
  UsageEvent,
  agentRepository,
  dataLakeRepository,
  creditTransactionRepository,
  userRepository,
} from '@bike4mind/database';

/**
 * GET /api/gears/status — the Gears progression surface.
 *
 * Two kinds of gear:
 *  - destination: a major feature that EARNS its sidenav slot on first use
 *    (the permanent rail is New Chat / Gears / Help).
 *  - skill: a capability worth discovering (issue an API key, generate an
 *    image, switch models, build a React artifact…) — no nav effect, just a
 *    checkmark on the Gears page and the credit reward. The tutorial system
 *    disguised as a trophy case.
 *
 * Unlock state is DERIVED — from feature data ("has ≥1 project") or from the
 * billing usage ledger (feature: image_generation / voice / completion_api,
 * distinct chat models) — so there is no unlock table to migrate or drift,
 * and users with existing history are grandfathered automatically. Receipt
 * counts as use: a project you were added to unlocks Projects.
 *
 * First unlock of each gear grants a one-time credit reward. Idempotency
 * rides the credit ledger itself: the stable transactionId
 * `gear-unlock:<userId>:<gearKey>` is a unique key on CreditTransaction, so a
 * duplicate grant attempt is swallowed by addCredits — this endpoint can be
 * polled freely and can never double-credit.
 */

/** One-time rewards; env-tunable without a deploy contract change. */
export const GEAR_UNLOCK_CREDITS = Number(process.env.GEAR_UNLOCK_CREDITS ?? 25);
export const GEAR_SKILL_CREDITS = Number(process.env.GEAR_SKILL_CREDITS ?? 10);

export type GearKind = 'destination' | 'skill';

export type GearKey =
  // destinations (earn a sidenav slot)
  | 'projects'
  | 'agents'
  | 'datalakes'
  | 'files'
  | 'published'
  // skills (achievements)
  | 'apikey'
  | 'apicall'
  | 'image'
  | 'voice'
  | 'models'
  | 'react'
  | 'python'
  | 'shareproject';

const gearTxId = (userId: string, key: GearKey) => `gear-unlock:${userId}:${key}`;

/** Facts gathered once per request and shared by every gear check — keeps the
 *  endpoint at a handful of indexed queries no matter how many gears exist. */
interface GearFacts {
  userId: string;
  usageFeatures: Set<string>;
  chatModelCount: number;
}

async function gatherFacts(userId: string): Promise<GearFacts> {
  const [usageFeatures, chatModels] = await Promise.all([
    UsageEvent.distinct('feature', { userId }) as Promise<string[]>,
    UsageEvent.distinct('model', { userId, feature: 'chat' }) as Promise<string[]>,
  ]);
  return { userId, usageFeatures: new Set(usageFeatures), chatModelCount: chatModels.length };
}

interface GearDef {
  key: GearKey;
  kind: GearKind;
  check: (facts: GearFacts) => Promise<boolean> | boolean;
}

const GEARS: GearDef[] = [
  // ── Destinations ─────────────────────────────────────────────────────────
  {
    key: 'projects',
    kind: 'destination',
    // Owner OR member — same membership arms as the publish project-visibility gate.
    check: async ({ userId }) => !!(await Project.exists({ $or: [{ userId }, { 'users.id': userId }] })),
  },
  {
    key: 'agents',
    kind: 'destination',
    check: async ({ userId }) => (await agentRepository.countByUserId(userId)) > 0,
  },
  {
    key: 'datalakes',
    kind: 'destination',
    check: async ({ userId }) => !!(await dataLakeRepository.findOne({ createdByUserId: userId })),
  },
  {
    key: 'files',
    kind: 'destination',
    check: async ({ userId }) => !!(await FabFile.exists({ userId })),
  },
  {
    key: 'published',
    kind: 'destination',
    check: async ({ userId }) => !!(await PublishedArtifact.exists({ ownerId: userId, deletedAt: null })),
  },
  // ── Skills ───────────────────────────────────────────────────────────────
  {
    key: 'apikey',
    kind: 'skill',
    check: async ({ userId }) => !!(await ApiKey.exists({ userId, isActive: true })),
  },
  {
    key: 'apicall',
    kind: 'skill',
    check: ({ usageFeatures }) => usageFeatures.has('completion_api'),
  },
  {
    key: 'image',
    kind: 'skill',
    check: ({ usageFeatures }) => usageFeatures.has('image_generation') || usageFeatures.has('image_edit'),
  },
  {
    key: 'voice',
    kind: 'skill',
    check: ({ usageFeatures }) => usageFeatures.has('voice'),
  },
  {
    // Ran chats on two or more distinct models — the "the grass is greener" tour.
    key: 'models',
    kind: 'skill',
    check: ({ chatModelCount }) => chatModelCount >= 2,
  },
  {
    key: 'react',
    kind: 'skill',
    check: async ({ userId }) => !!(await Artifact.exists({ userId, type: 'react' })),
  },
  {
    key: 'python',
    kind: 'skill',
    check: async ({ userId }) => !!(await Artifact.exists({ userId, type: 'python' })),
  },
  {
    // Sharing is the unlock: a project with at least one collaborator.
    key: 'shareproject',
    kind: 'skill',
    check: async ({ userId }) => !!(await Project.exists({ userId, 'users.0': { $exists: true } })),
  },
];

const creditsFor = (kind: GearKind) => (kind === 'destination' ? GEAR_UNLOCK_CREDITS : GEAR_SKILL_CREDITS);

export interface GearStatus {
  key: GearKey;
  kind: GearKind;
  unlocked: boolean;
  credits: number;
  /** Set only on the response that actually granted the reward. */
  creditsAwarded?: number;
}

const handler = baseApi().get(
  asyncHandler(async (req, res) => {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const facts = await gatherFacts(String(userId));
    const unlockedFlags = await Promise.all(GEARS.map(g => g.check(facts)));

    // One indexed query tells us which unlocks were already rewarded, so the
    // common case (nothing new) never attempts a ledger write.
    const txIds = GEARS.map(g => gearTxId(String(userId), g.key));
    const existing = await creditTransactionRepository.find({ transactionId: { $in: txIds } });
    const rewarded = new Set((existing as Array<{ transactionId?: string }>).map(t => t.transactionId).filter(Boolean));

    const gears: GearStatus[] = [];
    for (let i = 0; i < GEARS.length; i++) {
      const def = GEARS[i];
      const unlocked = unlockedFlags[i];
      const credits = creditsFor(def.kind);
      const gear: GearStatus = { key: def.key, kind: def.kind, unlocked, credits };
      if (unlocked && credits > 0 && !rewarded.has(gearTxId(String(userId), def.key))) {
        try {
          const holder = await creditService.addCredits(
            {
              ownerId: String(userId),
              ownerType: CreditHolderType.User,
              credits,
              type: 'generic_add',
              transactionId: gearTxId(String(userId), def.key),
              reason: `gear unlock: ${def.key}`,
            },
            { db: { creditTransactions: creditTransactionRepository }, creditHolderMethods: userRepository }
          );
          // addCredits returns the holder on success; a raced duplicate is
          // swallowed inside (unique transactionId) and never double-credits.
          if (holder) gear.creditsAwarded = credits;
        } catch (err) {
          // Reward failure must not break the status surface — the nav still
          // needs its answer. The stable transactionId makes any retry safe.
          req.logger?.warn?.({ err, key: def.key }, 'gear unlock credit grant failed');
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
