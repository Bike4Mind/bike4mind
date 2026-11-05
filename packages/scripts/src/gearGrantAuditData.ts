import mongoose from 'mongoose';
import { AI_USAGE_TRANSACTION_TYPES, CreditHolderType } from '@bike4mind/common';
import {
  CreditTransaction,
  GearOverride,
  HeldCreditRewardModel,
  PublishedArtifact,
  User,
  adminSettingsRepository,
} from '@bike4mind/database';
import { GEAR_KEYS, GEAR_TRUST_MIN_AGE_DAYS } from '@client/lib/gears/keys';
import { buildExclusionRules, exclusionReason } from './externalActiveUsers';
import {
  GEAR_TX_PREFIX,
  activeGearKeys,
  addSpend,
  attributeSpend,
  buildGearGrantReport,
  emptySpend,
  formatGearGrantReport,
  gearKeyOf,
  type AuditUser,
  type GearGrantReport,
  type GearOverrideRow,
  type GearPayoutRow,
  type HeldGearRow,
  type UsageRow,
} from './gearGrantAudit';

/** Reads for the gear grant audit. Read-only: every query is a find or distinct. */

const MS_PER_DAY = 86_400_000;
const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;
const USER_FIELDS = { email: 1, isAdmin: 1, isSynthetic: 1, createdAt: 1, emailVerified: 1, emailVerifiedAt: 1 };
const HELD_FIELDS = { transactionId: 1, userId: 1, status: 1, heldAt: 1 };

export interface GearGrantAuditOptions {
  days: number;
  withinDays: number;
  top: number;
  testPattern: RegExp;
  staffDomainsEnv?: string;
  now?: Date;
  batchSize?: number;
}

type UserDoc = AuditUser & { _id: unknown };

async function loadUsers(userIds: string[], windowStart: Date, batchSize: number): Promise<Map<string, AuditUser>> {
  const users = new Map<string, AuditUser>();
  const valid = userIds.filter(id => OBJECT_ID_RE.test(id));
  for (let i = 0; i < valid.length; i += batchSize) {
    const batch = valid.slice(i, i + batchSize).map(id => new mongoose.Types.ObjectId(id));
    const docs = await User.find({ _id: { $in: batch } }, USER_FIELDS)
      .read('secondaryPreferred')
      .lean<UserDoc[]>();
    for (const { _id, ...user } of docs) users.set(String(_id), user);
  }
  const signups = User.find({ createdAt: { $gte: windowStart } }, USER_FIELDS)
    .read('secondaryPreferred')
    .lean<UserDoc[]>()
    .cursor({ batchSize });
  for await (const { _id, ...user } of signups) users.set(String(_id), user);
  return users;
}

/** The gearRewardMinAccountAgeDays setting, read the way loadGearMinAccountAgeDays in the gears catalog reads it. */
export const resolveMinAccountAgeDays = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : GEAR_TRUST_MIN_AGE_DAYS;

export async function runGearGrantAudit(
  options: GearGrantAuditOptions
): Promise<{ report: GearGrantReport; markdown: string }> {
  const {
    days,
    withinDays,
    top,
    testPattern,
    staffDomainsEnv = process.env.NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS,
    now = new Date(),
    batchSize = 1000,
  } = options;
  const windowStart = new Date(now.getTime() - days * MS_PER_DAY);
  const rules = buildExclusionRules(staffDomainsEnv, testPattern);

  // The transactionId index has no createdAt, so this walks every gear payout ever; fine for an ad hoc report.
  const payoutDocs = await CreditTransaction.find(
    {
      transactionId: { $regex: `^${GEAR_TX_PREFIX}` },
      credits: { $gt: 0 },
      createdAt: { $gte: windowStart, $lte: now },
    },
    { ownerId: 1, transactionId: 1, credits: 1, createdAt: 1 }
  )
    .read('secondaryPreferred')
    .lean<Array<{ ownerId: string; transactionId: string; credits: number; createdAt: Date }>>();
  const payouts: GearPayoutRow[] = payoutDocs.map(d => ({
    transactionId: d.transactionId,
    userId: d.ownerId,
    credits: d.credits,
    paidAt: d.createdAt,
  }));

  const held = await HeldCreditRewardModel.find(
    // The status clause matches every row; it is there so the {status, heldAt} index serves the range.
    { source: 'gear', status: { $in: ['held', 'paid', 'void', 'paused'] }, heldAt: { $gte: windowStart, $lte: now } },
    HELD_FIELDS
  )
    .read('secondaryPreferred')
    .lean<HeldGearRow[]>();
  // Queue rows held before the window whose payout landed inside it.
  for (let i = 0; i < payouts.length; i += batchSize) {
    const rows = await HeldCreditRewardModel.find(
      {
        source: 'gear',
        heldAt: { $lt: windowStart },
        transactionId: { $in: payouts.slice(i, i + batchSize).map(p => p.transactionId) },
      },
      HELD_FIELDS
    )
      .read('secondaryPreferred')
      .lean<HeldGearRow[]>();
    held.push(...rows);
  }

  const ownerIds = [...new Set([...payouts.map(p => p.userId), ...held.map(h => h.userId)])];
  const users = await loadUsers(ownerIds, windowStart, batchSize);
  const recipients = [...new Set(payouts.map(p => p.userId))].filter(
    id => exclusionReason(users.get(id), rules) === null
  );

  const firstPaidAt = new Map<string, number>();
  const payoutsByUser = new Map<string, GearPayoutRow[]>();
  for (const p of payouts) {
    const at = p.paidAt.getTime();
    if (at < (firstPaidAt.get(p.userId) ?? Infinity)) firstPaidAt.set(p.userId, at);
    const list = payoutsByUser.get(p.userId) ?? [];
    list.push(p);
    payoutsByUser.set(p.userId, list);
  }

  const freeTierModels = new Set(await adminSettingsRepository.getSettingsValue('freeTierAllowedModels'));

  // Only usage from each recipient's first payout on is attributed, so earlier rows are neither read nor
  // kept. Each batch is attributed and dropped, so memory is bounded by one batch's usage.
  const spend = emptySpend();
  for (let i = 0; i < recipients.length; i += batchSize) {
    const batch = recipients.slice(i, i + batchSize);
    const usage: UsageRow[] = [];
    const from = Math.min(...batch.map(id => firstPaidAt.get(id) as number));
    const rows = CreditTransaction.find(
      {
        ownerId: { $in: batch },
        ownerType: CreditHolderType.User,
        type: { $in: AI_USAGE_TRANSACTION_TYPES },
        createdAt: { $gte: new Date(from), $lte: now },
      },
      { ownerId: 1, model: 1, credits: 1, createdAt: 1 }
    )
      .read('secondaryPreferred')
      .lean<Array<{ ownerId: string; model?: string | null; credits: number; createdAt: Date }>>()
      .cursor({ batchSize });
    for await (const row of rows) {
      if (row.createdAt.getTime() < (firstPaidAt.get(row.ownerId) as number)) continue;
      usage.push({ userId: row.ownerId, model: row.model ?? null, credits: Math.abs(row.credits), at: row.createdAt });
    }
    addSpend(
      spend,
      attributeSpend(
        batch.flatMap(id => payoutsByUser.get(id) ?? []),
        usage,
        freeTierModels
      )
    );
  }

  const publishedOwners = new Set(payouts.filter(p => gearKeyOf(p.transactionId) === 'published').map(p => p.userId));
  const publishers = recipients.filter(id => publishedOwners.has(id));
  const viewed = new Set<string>();
  for (let i = 0; i < publishers.length; i += batchSize) {
    const owners = (await PublishedArtifact.distinct('ownerId', {
      ownerId: { $in: publishers.slice(i, i + batchSize) },
      deletedAt: null,
      externalViewCount: { $gte: 1 },
    })) as string[];
    for (const owner of owners) viewed.add(owner);
  }

  const overrides = await GearOverride.find({}, { key: 1, enabled: 1, credits: 1 }).lean<GearOverrideRow[]>();
  const minAccountAgeDays = resolveMinAccountAgeDays(
    await adminSettingsRepository.getSettingsValue('gearRewardMinAccountAgeDays')
  );

  const report = buildGearGrantReport({
    now,
    days,
    withinDays,
    top,
    payouts,
    held,
    spend,
    users,
    rules,
    activeGearKeys: activeGearKeys(GEAR_KEYS, overrides),
    freeTierModels,
    minAccountAgeDays,
    externallyViewedPublishers: viewed,
  });
  return { report, markdown: formatGearGrantReport(report) };
}
