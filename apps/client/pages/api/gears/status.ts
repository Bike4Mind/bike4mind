import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
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
  hearthRepository,
  importHistoryJobRepository,
  rapidReplyAuditLogRepository,
  researchDataRepository,
} from '@bike4mind/database';

/**
 * GET /api/gears/status - the Gears progression surface.
 *
 * Two kinds of gear: destination (earns a sidenav slot on first use) and
 * skill (a checkmark + credit reward, no nav effect).
 *
 * Unlock state is DERIVED - from feature data or the billing usage ledger -
 * so there is no unlock table to migrate or drift, and existing history is
 * grandfathered automatically (a project you were added to unlocks Projects).
 *
 * This endpoint only reads. The reward is paid by POST /api/gears/claim when
 * the user asks for it, so the status can be polled from anywhere in the app
 * without moving anyone's balance.
 *
 * Idempotency rides the credit ledger: the stable transactionId
 * `gear-unlock:<userId>:<gearKey>` is a unique key on CreditTransaction, so a
 * duplicate grant is swallowed by addCredits and a gear can never pay twice.
 */

/**
 * One-time rewards per gear: destinations 1,000; skills 100-1,000 by
 * complexity; social actions 5,000. GEAR_CREDITS_SCALE globally scales the
 * schedule without a deploy - exported so the Manage Gears admin dashboard
 * reports the SAME scaled amount users are paid (else a credit audit
 * reconciles against wrong numbers).
 */
export const GEAR_CREDITS_SCALE = (() => {
  const raw = Number(process.env.GEAR_CREDITS_SCALE ?? 1);
  // A malformed value (e.g. '2x') is NaN, and Math.round(NaN) silently zeroes
  // EVERY reward (`credits > 0` becomes false). Fall back to 1 (unscaled).
  return Number.isFinite(raw) && raw >= 0 ? raw : 1;
})();

export type GearKind = 'destination' | 'skill';

export type GearKey =
  // destinations (earn a sidenav slot)
  | 'projects'
  | 'agents'
  | 'datalakes'
  | 'files'
  | 'published'
  | 'hearth'
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
  | 'music'
  | 'sound'
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

export const gearTxId = (userId: string, key: GearKey) => `gear-unlock:${userId}:${key}`;

/** Facts gathered once per request and shared by every gear check - keeps the
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

export interface GearDef {
  key: GearKey;
  kind: GearKind;
  /** One-time unlock reward (pre-scale) - see the schedule note above. */
  credits: number;
  check: (facts: GearFacts) => Promise<boolean> | boolean;
  /** When set, the credit payout waits for THIS stricter condition while the
   *  unlock (checkmark / nav slot) still follows `check`. Used where the
   *  reward needs anti-farm friction the unlock shouldn't have. */
  rewardCheck?: (facts: GearFacts) => Promise<boolean> | boolean;
}

const GEARS: GearDef[] = [
  // --- Destinations ---
  {
    key: 'projects',
    credits: 1000,
    kind: 'destination',
    // Owner OR member. Membership rows are { userId, permissions } (see
    // sharingService pushShareable) - the path is users.userId, NOT users.id.
    check: async ({ userId }) => !!(await Project.exists({ $or: [{ userId }, { 'users.userId': userId }] })),
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
    // Nav slot unlocks on publish; the credit payout waits for a NON-OWNER
    // view (anti-farm: "someone saw your work", not "you clicked publish").
    key: 'published',
    credits: 5000,
    kind: 'destination',
    check: async ({ userId }) => !!(await PublishedArtifact.exists({ ownerId: userId, deletedAt: null })),
    rewardCheck: async ({ userId }) =>
      !!(await PublishedArtifact.exists({ ownerId: userId, deletedAt: null, externalViewCount: { $gte: 1 } })),
  },
  {
    // Derived, not stamped: a channel is the durable trace of using Hearth, and
    // channels are how a user reaches the log at all - so owning one is the unlock.
    key: 'hearth',
    credits: 1000,
    kind: 'destination',
    check: async ({ userId }) => hearthRepository.hasAnyChannelForUser(userId),
  },
  // --- Skills ---
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
    // A project with at least one collaborator.
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
    key: 'music',
    credits: 250,
    kind: 'skill',
    check: ({ usageFeatures }) => usageFeatures.has('music_generation'),
  },
  {
    // Only the sound-effect half of audio_generation: text-to-speech reads text
    // that already exists, which is a different act from generating media.
    key: 'sound',
    credits: 250,
    kind: 'skill',
    check: ({ usageFeatures }) => usageFeatures.has('sound_effects'),
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
    // The partial index on slackMetadata exists for exactly this query shape.
    key: 'slack',
    credits: 1000,
    kind: 'skill',
    check: async ({ userId }) => !!(await Session.exists({ userId, slackMetadata: { $exists: true, $ne: null } })),
  },
  {
    // Each imported history is its own reward (OpenAI and Claude count separately).
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
    // Your agent public or explicitly shared with others.
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
  // Tool gears - stamped by the shared-pipeline tool-finish observer
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
    // Client-claimable curiosity stamp (self-attested doc visit); see the
    // allowlist note in pages/api/gears/stamp.ts.
    key: 'clidocs',
    credits: 100,
    kind: 'skill',
    check: ({ stamps }) => stamps.has('clidocs'),
  },
];

const creditsFor = (def: GearDef) => Math.round(def.credits * GEAR_CREDITS_SCALE);

/** Code-defined gear defaults, exported for the Manage Gears admin dashboard
 *  (key/kind/credits only - checks stay private to this endpoint). */
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
  /** Unlocked and paid-for conditions met, but the reward is not claimed yet. */
  claimable?: boolean;
  /** The ledger has paid this gear. Independent of `unlocked`, which follows live
   *  data: deleting your only agent re-locks the gear, but the reward stays spent. */
  claimed?: boolean;
  /** Unlocked, but the payout's stricter condition isn't met yet (e.g.
   *  Published: waiting for a non-owner view). */
  rewardPending?: boolean;
}

export interface GearEvaluation {
  def: GearDef;
  unlocked: boolean;
  /** Effective amount: an admin override is ABSOLUTE (not scaled), so what the
   *  admin typed is exactly what pays out. */
  credits: number;
  /** The payout's own condition - `rewardCheck` where the gear has one. */
  rewardEligible: boolean;
  alreadyRewarded: boolean;
}

/**
 * Every active gear's unlock and reward state for one user. Shared by this
 * endpoint and the claim one, so the button a user sees and the payout it
 * triggers are decided by the same code.
 *
 * `onlyKeys` narrows the checks to the gears asked about; the facts are
 * gathered in full either way, since they are a fixed handful of queries.
 */
export async function evaluateGears(
  userId: string,
  onlyKeys?: GearKey[]
): Promise<{ evaluations: GearEvaluation[]; overrides: Awaited<ReturnType<typeof gearOverrideRepository.byKey>> }> {
  // Admin overrides (Manage Gears) layer over the code defaults: disabled
  // gears vanish (no card, no payout).
  const [facts, overrides] = await Promise.all([gatherFacts(userId), gearOverrideRepository.byKey()]);
  const activeGears = GEARS.filter(
    g => overrides.get(g.key)?.enabled !== false && (!onlyKeys || onlyKeys.includes(g.key))
  );
  const unlockedFlags = await Promise.all(activeGears.map(g => g.check(facts)));

  // One indexed query tells us which unlocks were already rewarded.
  const txIds = activeGears.map(g => gearTxId(userId, g.key));
  const existing = await creditTransactionRepository.find({ transactionId: { $in: txIds } });
  const rewarded = new Set((existing as Array<{ transactionId?: string }>).map(t => t.transactionId).filter(Boolean));

  const evaluations = await Promise.all(
    activeGears.map(async (def, i) => {
      const unlocked = unlockedFlags[i];
      const alreadyRewarded = rewarded.has(gearTxId(userId, def.key));
      // The payout may lag the unlock behind a stricter condition (anti-farm
      // friction); evaluate it only when it could change the outcome.
      const rewardEligible = unlocked && !alreadyRewarded && def.rewardCheck ? await def.rewardCheck(facts) : unlocked;
      return {
        def,
        unlocked,
        credits: overrides.get(def.key)?.credits ?? creditsFor(def),
        rewardEligible,
        alreadyRewarded,
      };
    })
  );
  return { evaluations, overrides };
}

const handler = baseApi().get(
  asyncHandler(async (req, res) => {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const { evaluations, overrides } = await evaluateGears(String(userId));
    const gears: GearStatus[] = evaluations.map(({ def, unlocked, credits, rewardEligible, alreadyRewarded }) => {
      const o = overrides.get(def.key);
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
      if (unlocked && !rewardEligible && !alreadyRewarded) gear.rewardPending = true;
      if (rewardEligible && credits > 0 && !alreadyRewarded) gear.claimable = true;
      if (alreadyRewarded) gear.claimed = true;
      return gear;
    });

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
