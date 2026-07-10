import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { CreditHolderType } from '@bike4mind/common';
import { creditService } from '@bike4mind/services';
import { GEAR_PRESENTATION } from '@client/lib/gears/presentation';
import {
  Project,
  FabFile,
  PublishedArtifact,
  Artifact,
  ApiKey,
  UsageEvent,
  User,
  Session,
  Agent,
  Memento,
  QuestMasterPlan,
  McpServer,
  agentRepository,
  dataLakeRepository,
  creditTransactionRepository,
  gearStampRepository,
  gearOverrideRepository,
  importHistoryJobRepository,
  rapidReplyAuditLogRepository,
  researchDataRepository,
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

/**
 * One-time rewards, per gear. The schedule (Erik, 2026-07-10):
 *  - destinations (earn a sidenav slot): 1,000 each
 *  - skills: 100-1,000 scaled by implied complexity (a one-prompt image is a
 *    nudge; a working API integration is real onboarding)
 *  - anything SOCIAL — actions that pull other people in — 5,000. Sharing is
 *    the growth loop; pay for it like one.
 * GEAR_CREDITS_SCALE lets an operator globally scale the schedule without a deploy.
 */
const GEAR_CREDITS_SCALE = Number(process.env.GEAR_CREDITS_SCALE ?? 1);

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
  | 'shareproject'
  | 'questmaster'
  | 'mementos'
  | 'video'
  | 'mcp'
  | 'mfa'
  | 'slack'
  | 'importopenai'
  | 'importclaude'
  | 'research'
  | 'rapidreply'
  | 'shareagent'
  // skills recorded via first-use stamps (see server/services/gears/stampGear.ts)
  | 'downloadnotebook'
  | 'forknotebook'
  | 'websearch'
  | 'webfetch'
  | 'wolfram'
  | 'matheval'
  // client-claimable curiosity stamps (see pages/api/gears/stamp.ts)
  | 'clidocs';

const gearTxId = (userId: string, key: GearKey) => `gear-unlock:${userId}:${key}`;

/** Facts gathered once per request and shared by every gear check — keeps the
 *  endpoint at a handful of indexed queries no matter how many gears exist. */
interface GearFacts {
  userId: string;
  usageFeatures: Set<string>;
  chatModelCount: number;
  stamps: Set<string>;
}

async function gatherFacts(userId: string): Promise<GearFacts> {
  const [usageFeatures, chatModels, stamps] = await Promise.all([
    UsageEvent.distinct('feature', { userId }) as Promise<string[]>,
    UsageEvent.distinct('model', { userId, feature: 'chat' }) as Promise<string[]>,
    gearStampRepository.stampedKeys(userId),
  ]);
  return { userId, usageFeatures: new Set(usageFeatures), chatModelCount: chatModels.length, stamps };
}

interface GearDef {
  key: GearKey;
  kind: GearKind;
  /** One-time unlock reward (pre-scale) — see the schedule note above. */
  credits: number;
  check: (facts: GearFacts) => Promise<boolean> | boolean;
  /** When set, the credit payout waits for THIS stricter condition while the
   *  unlock (checkmark / nav slot) still follows `check`. Used where the
   *  reward needs anti-farm friction the unlock shouldn't have. */
  rewardCheck?: (facts: GearFacts) => Promise<boolean> | boolean;
}

const GEARS: GearDef[] = [
  // ── Destinations ─────────────────────────────────────────────────────────
  {
    key: 'projects',
    credits: 1000,
    kind: 'destination',
    // Owner OR member — same membership arms as the publish project-visibility gate.
    check: async ({ userId }) => !!(await Project.exists({ $or: [{ userId }, { 'users.id': userId }] })),
  },
  {
    key: 'agents',
    credits: 1000,
    kind: 'destination',
    check: async ({ userId }) => (await agentRepository.countByUserId(userId)) > 0,
  },
  {
    key: 'datalakes',
    credits: 1000,
    kind: 'destination',
    check: async ({ userId }) => !!(await dataLakeRepository.findOne({ createdByUserId: userId })),
  },
  {
    key: 'files',
    credits: 1000,
    kind: 'destination',
    check: async ({ userId }) => !!(await FabFile.exists({ userId })),
  },
  {
    // 5,000 (social pricing): publishing is the growth loop. The NAV SLOT
    // unlocks on publish (you used the feature); the credit payout waits for
    // a NON-OWNER view — "someone saw your work", not "you clicked publish".
    // Farming friction, not proof (b4m-strategy#93 tracks the rest).
    key: 'published',
    credits: 5000,
    kind: 'destination',
    check: async ({ userId }) => !!(await PublishedArtifact.exists({ ownerId: userId, deletedAt: null })),
    rewardCheck: async ({ userId }) =>
      !!(await PublishedArtifact.exists({ ownerId: userId, deletedAt: null, externalViewCount: { $gte: 1 } })),
  },
  // ── Skills ───────────────────────────────────────────────────────────────
  {
    key: 'apikey',
    credits: 500,
    kind: 'skill',
    check: async ({ userId }) => !!(await ApiKey.exists({ userId, isActive: true })),
  },
  {
    key: 'apicall',
    credits: 1000,
    kind: 'skill',
    check: ({ usageFeatures }) => usageFeatures.has('completion_api'),
  },
  {
    key: 'image',
    credits: 100,
    kind: 'skill',
    check: ({ usageFeatures }) => usageFeatures.has('image_generation') || usageFeatures.has('image_edit'),
  },
  {
    key: 'voice',
    credits: 250,
    kind: 'skill',
    check: ({ usageFeatures }) => usageFeatures.has('voice'),
  },
  {
    // Ran chats on two or more distinct models — the "the grass is greener" tour.
    key: 'models',
    credits: 250,
    kind: 'skill',
    check: ({ chatModelCount }) => chatModelCount >= 2,
  },
  {
    key: 'react',
    credits: 500,
    kind: 'skill',
    check: async ({ userId }) => !!(await Artifact.exists({ userId, type: 'react' })),
  },
  {
    key: 'python',
    credits: 500,
    kind: 'skill',
    check: async ({ userId }) => !!(await Artifact.exists({ userId, type: 'python' })),
  },
  {
    // Sharing is the unlock: a project with at least one collaborator.
    key: 'shareproject',
    credits: 5000,
    kind: 'skill',
    check: async ({ userId }) => !!(await Project.exists({ userId, 'users.0': { $exists: true } })),
  },
  {
    key: 'questmaster',
    credits: 1000,
    kind: 'skill',
    check: async ({ userId }) => !!(await QuestMasterPlan.exists({ userId })),
  },
  {
    key: 'mementos',
    credits: 250,
    kind: 'skill',
    check: async ({ userId }) => !!(await Memento.exists({ userId })),
  },
  {
    key: 'video',
    credits: 250,
    kind: 'skill',
    check: ({ usageFeatures }) => usageFeatures.has('video_generation'),
  },
  {
    key: 'mcp',
    credits: 1000,
    kind: 'skill',
    check: async ({ userId }) => !!(await McpServer.exists({ userId })),
  },
  {
    key: 'mfa',
    credits: 500,
    kind: 'skill',
    check: async ({ userId }) => !!(await User.exists({ _id: userId, 'mfa.totpEnabled': true })),
  },
  {
    // A notebook that lives in Slack — the partial index on slackMetadata
    // exists for exactly this shape of query.
    key: 'slack',
    credits: 1000,
    kind: 'skill',
    check: async ({ userId }) => !!(await Session.exists({ userId, slackMetadata: { $exists: true, $ne: null } })),
  },
  {
    // Split imports (Erik, 2026-07-10): each history you bring over is its own
    // earned reward — imported history is switching-cost reversal.
    key: 'importopenai',
    credits: 1000,
    kind: 'skill',
    check: async ({ userId }) =>
      !!(await importHistoryJobRepository.findOne({ userId, source: 'OpenAI', status: 'completed' })),
  },
  {
    key: 'importclaude',
    credits: 1000,
    kind: 'skill',
    check: async ({ userId }) =>
      !!(await importHistoryJobRepository.findOne({ userId, source: 'Claude', status: 'completed' })),
  },
  {
    key: 'research',
    credits: 500,
    kind: 'skill',
    check: async ({ userId }) => !!(await researchDataRepository.findOne({ userId })),
  },
  {
    key: 'rapidreply',
    credits: 250,
    kind: 'skill',
    check: async ({ userId }) => !!(await rapidReplyAuditLogRepository.findOne({ userId })),
  },
  {
    // SOCIAL: your agent in someone else's hands — public or explicitly shared.
    key: 'shareagent',
    credits: 5000,
    kind: 'skill',
    check: async ({ userId }) =>
      !!(await Agent.exists({ userId, $or: [{ isPublic: true }, { 'users.0': { $exists: true } }] })),
  },
  // Stamp-backed skills: the action leaves no other queryable trace, so the
  // action's route stamps first use (stampGear) and the check reads the stamp.
  {
    key: 'downloadnotebook',
    credits: 250,
    kind: 'skill',
    check: ({ stamps }) => stamps.has('downloadnotebook'),
  },
  {
    key: 'forknotebook',
    credits: 100,
    kind: 'skill',
    check: ({ stamps }) => stamps.has('forknotebook'),
  },
  // Tool gears — stamped by the shared-pipeline tool-finish observer
  // (server/services/gears/toolGearObserver.ts): zero-latency by contract.
  {
    key: 'websearch',
    credits: 100,
    kind: 'skill',
    check: ({ stamps }) => stamps.has('websearch'),
  },
  {
    key: 'webfetch',
    credits: 100,
    kind: 'skill',
    check: ({ stamps }) => stamps.has('webfetch'),
  },
  {
    key: 'wolfram',
    credits: 250,
    kind: 'skill',
    check: ({ stamps }) => stamps.has('wolfram'),
  },
  {
    key: 'matheval',
    credits: 100,
    kind: 'skill',
    check: ({ stamps }) => stamps.has('matheval'),
  },
  {
    // Client-claimable curiosity stamp (self-attested doc visit) — priced
    // accordingly; see the allowlist note in pages/api/gears/stamp.ts.
    key: 'clidocs',
    credits: 100,
    kind: 'skill',
    check: ({ stamps }) => stamps.has('clidocs'),
  },
];

const creditsFor = (def: GearDef) => Math.round(def.credits * GEAR_CREDITS_SCALE);

/** Code-defined gear defaults, exported for the Manage Gears admin dashboard
 *  (key/kind/credits only — checks stay private to this endpoint). */
export const GEAR_DEFAULTS: Array<{ key: GearKey; kind: GearKind; credits: number }> = GEARS.map(g => ({
  key: g.key,
  kind: g.kind,
  credits: g.credits,
}));

export interface GearStatus {
  key: GearKey;
  kind: GearKind;
  unlocked: boolean;
  credits: number;
  /** Presentation, admin-override-merged over the code defaults. */
  title: string;
  tagline: string;
  intro: string;
  cta: string;
  ctaAction: string;
  /** Set only on the response that actually granted the reward. */
  creditsAwarded?: number;
  /** Unlocked, but the payout's stricter condition isn't met yet (e.g.
   *  Published: waiting for a non-owner view). */
  rewardPending?: boolean;
}

const handler = baseApi().get(
  asyncHandler(async (req, res) => {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    // Admin overrides (Manage Gears) layer over the code defaults: disabled
    // gears vanish (no card, no payout); a credits override is ABSOLUTE (not
    // scaled) so what the admin typed is exactly what pays out.
    const [facts, overrides] = await Promise.all([gatherFacts(String(userId)), gearOverrideRepository.byKey()]);
    const activeGears = GEARS.filter(g => overrides.get(g.key)?.enabled !== false);
    const unlockedFlags = await Promise.all(activeGears.map(g => g.check(facts)));

    // One indexed query tells us which unlocks were already rewarded, so the
    // common case (nothing new) never attempts a ledger write.
    const txIds = activeGears.map(g => gearTxId(String(userId), g.key));
    const existing = await creditTransactionRepository.find({ transactionId: { $in: txIds } });
    const rewarded = new Set((existing as Array<{ transactionId?: string }>).map(t => t.transactionId).filter(Boolean));

    const gears: GearStatus[] = [];
    for (let i = 0; i < activeGears.length; i++) {
      const def = activeGears[i];
      const unlocked = unlockedFlags[i];
      const o = overrides.get(def.key);
      const credits = o?.credits ?? creditsFor(def);
      const base = GEAR_PRESENTATION[def.key];
      const gear: GearStatus = {
        key: def.key,
        kind: def.kind,
        unlocked,
        credits,
        title: o?.title ?? base.title,
        tagline: o?.tagline ?? base.tagline,
        intro: o?.intro ?? base.intro,
        cta: o?.cta ?? base.cta,
        ctaAction: o?.ctaAction ?? base.ctaAction,
      };
      const alreadyRewarded = rewarded.has(gearTxId(String(userId), def.key));
      // The payout may lag the unlock behind a stricter condition (anti-farm
      // friction) — evaluate it only when it could actually change the outcome.
      const rewardEligible = unlocked && !alreadyRewarded && def.rewardCheck ? await def.rewardCheck(facts) : unlocked;
      if (unlocked && !rewardEligible && !alreadyRewarded) gear.rewardPending = true;
      if (rewardEligible && credits > 0 && !alreadyRewarded) {
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
    });
  })
);

export const config = {
  api: { externalResolver: true },
};

export default handler;
