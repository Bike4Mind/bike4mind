import {
  GEAR_KEYS,
  GEAR_TRUST_MIN_AGE_DAYS,
  type GearKey,
  type GearKind,
  type GearPendingReason,
} from '@client/lib/gears/keys';
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
  adminSettingsRepository,
  creditTransactionRepository,
  gearStampRepository,
  gearOverrideRepository,
  hearthRepository,
  importHistoryJobRepository,
  rapidReplyAuditLogRepository,
  researchDataRepository,
} from '@bike4mind/database';

/**
 * The gear catalog and its evaluation, shared by GET /api/gears/status, POST
 * /api/gears/claim and the Manage Gears admin endpoint - kept out of the route files so
 * no route imports another.
 *
 * Unlock state is DERIVED - from feature data or the billing usage ledger -
 * so there is no unlock table to migrate or drift, and existing history is
 * grandfathered automatically (a project you were added to unlocks Projects).
 *
 * Idempotency rides the credit ledger: the stable transactionId
 * `gear-unlock:<userId>:<gearKey>` is a unique key on CreditTransaction, so a
 * gear can never pay twice (see the claim endpoint).
 */

export { GEAR_KEYS };
export type { GearKey, GearKind, GearPendingReason };

/**
 * One-time rewards per gear: destinations 1,000; skills 100-1,000 by
 * complexity; social actions 5,000. GEAR_CREDITS_SCALE globally scales the
 * schedule without a deploy - exported so the Manage Gears admin dashboard
 * reports the SAME scaled amount users are paid (else a credit audit
 * reconciles against wrong numbers).
 */
export const GEAR_CREDITS_SCALE = (() => {
  const env = process.env.GEAR_CREDITS_SCALE?.trim();
  const raw = env ? Number(env) : 1;
  // A malformed value (e.g. '2x') is NaN, and Math.round(NaN) silently zeroes
  // EVERY reward (`credits > 0` becomes false). Fall back to 1 (unscaled).
  return Number.isFinite(raw) && raw >= 0 ? raw : 1;
})();

export const gearTxId = (userId: string, key: GearKey) => `gear-unlock:${userId}:${key}`;

/** Facts gathered once per request and shared by every gear check - keeps the
 *  endpoint at a handful of indexed queries no matter how many gears exist. */
interface GearFacts {
  userId: string;
  usageFeatures: Set<string>;
  chatModelCount: number;
  stamps: Set<string>;
  accountAgeInDays: number;
  emailVerified: boolean;
}

async function gatherFacts(userId: string): Promise<GearFacts> {
  const [usageFeatures, chatModels, stamps, user] = await Promise.all([
    UsageEvent.distinct('feature', { userId }) as Promise<string[]>,
    UsageEvent.distinct('model', { userId, feature: 'chat' }) as Promise<string[]>,
    gearStampRepository.stampedKeys(userId),
    User.findById(userId, { createdAt: 1, emailVerified: 1 }).lean() as Promise<{
      createdAt?: Date;
      emailVerified?: boolean;
    } | null>,
  ]);
  // Mirrors accountCreatedMs in userApiKeyService/trust.ts.
  const createdAtMs = user?.createdAt ? new Date(user.createdAt).getTime() : NaN;
  const createdMs = Number.isFinite(createdAtMs)
    ? createdAtMs
    : /^[0-9a-f]{24}$/i.test(userId)
      ? parseInt(userId.slice(0, 8), 16) * 1000
      : NaN;
  const accountAgeInDays = Number.isFinite(createdMs) ? (Date.now() - createdMs) / (1000 * 60 * 60 * 24) : 0;
  return {
    userId,
    usageFeatures: new Set(usageFeatures),
    chatModelCount: chatModels.length,
    stamps,
    accountAgeInDays,
    emailVerified: user?.emailVerified ?? false,
  };
}

export interface GearDef {
  key: GearKey;
  kind: GearKind;
  /** One-time unlock reward (pre-scale) - see the schedule note above. */
  credits: number;
  check: (facts: GearFacts) => Promise<boolean> | boolean;
  /** When set, the credit payout waits for THIS stricter condition while the
   *  unlock still follows `check`. Used where the
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
    // Nav slot unlocks on publish; the credit payout waits for a SIGNED-IN NON-OWNER
    // view (anti-farm: "someone saw your work", not "you clicked publish"). An anonymous
    // view never counts - it could be the owner. Counted by the serve route for a request
    // that carries a credential, and for bundle pages by /api/publish/view.
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
    // Filters on slackMetadata.channelId (required on the subdocument) rather than slackMetadata
    // itself so the query implies the partial userId_1_slackNotebook index's filter.
    key: 'slack',
    credits: 1000,
    kind: 'skill',
    check: async ({ userId }) => !!(await Session.exists({ userId, 'slackMetadata.channelId': { $exists: true } })),
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
  // (packages/server-utils/src/services/gears/toolGearObserver.ts): zero-latency by contract.
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

export interface GearEvaluation {
  def: GearDef;
  unlocked: boolean;
  /** Effective amount: an admin override is ABSOLUTE (not scaled), so what the
   *  admin typed is exactly what pays out. */
  credits: number;
  /** The payout's own condition - `rewardCheck` where the gear has one. */
  rewardEligible: boolean;
  alreadyRewarded: boolean;
  /** Why rewardEligible is false for an unlocked, unpaid gear. */
  pendingReason?: GearPendingReason;
}

/** The gearRewardMinAccountAgeDays admin setting, or the code default when unset or unreadable. */
export async function loadGearMinAccountAgeDays(): Promise<number> {
  const value = await adminSettingsRepository.getSettingsValue('gearRewardMinAccountAgeDays');
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : GEAR_TRUST_MIN_AGE_DAYS;
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
): Promise<{
  evaluations: GearEvaluation[];
  overrides: Awaited<ReturnType<typeof gearOverrideRepository.byKey>>;
  minAccountAgeDays: number;
}> {
  // Admin overrides (Manage Gears) layer over the code defaults: disabled
  // gears vanish (no card, no payout).
  const [facts, overrides, minAccountAgeDays] = await Promise.all([
    gatherFacts(userId),
    gearOverrideRepository.byKey(),
    loadGearMinAccountAgeDays(),
  ]);
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
      const credits = overrides.get(def.key)?.credits ?? creditsFor(def);

      let rewardEligible: boolean;
      let pendingReason: GearPendingReason | undefined;
      // Payouts require email verification and age even when API-key access has
      // an admin, purchase, plan or manual-approval exemption: access is not a reward.
      if (!unlocked || alreadyRewarded) {
        rewardEligible = unlocked;
      } else if (!facts.emailVerified) {
        rewardEligible = false;
        pendingReason = 'unverified';
      } else if (facts.accountAgeInDays < minAccountAgeDays) {
        rewardEligible = false;
        pendingReason = 'too_new';
      } else {
        const rewardCheckPassed = def.rewardCheck ? await def.rewardCheck(facts) : true;
        rewardEligible = rewardCheckPassed;
        if (!rewardCheckPassed) pendingReason = 'reward_check';
      }

      return {
        def,
        unlocked,
        credits,
        rewardEligible,
        alreadyRewarded,
        pendingReason,
      };
    })
  );
  return { evaluations, overrides, minAccountAgeDays };
}
