import {
  PENDING_FREE_CREDITS_TAG,
  resolveSignupGrantSchedule,
  signupGrantDripOpen,
  signupGrantDripRemaining,
  type SignupGrant,
  type SignupGrantDripCapSource,
} from '@bike4mind/common';
import { adminSettingsRepository, User } from '@bike4mind/database';
import { LEDGER_BATCH_SIZE, readReceivedCredits } from './signupGrantLedger';

const DAY_MS = 24 * 60 * 60 * 1000;

export const BUCKET_LABELS = ['<0', '0', '1', '2-99', '100-999', '1000+'] as const;
export type Bucket = (typeof BUCKET_LABELS)[number];
export type BucketCounts = Record<Bucket, number>;

export interface SignupGrantSizingReport {
  generatedAt: string;
  users: { total: number; withSignupGrant: number; withoutSignupGrant: number };
  /** Accounts with no `signupGrant`: the flat-grant cohort, which the migration leaves untouched. */
  flatGrant: {
    verified: number;
    unverified: number;
    verifiedBalance: BucketCounts;
    verifiedReceived: BucketCounts;
  };
  banned: number;
  admins: number;
  /** Non-banned accounts active within the last 30 days. */
  activeLast30Days: number;
  pendingFreeCreditsTagged: number;
  staged: {
    byStage: Record<SignupGrant['stage'], number>;
    /** Accounts the drip can still pay: mid-drip, or completed by the drip and reopenable by a raised cap. */
    inFlight: number;
    inFlightReceived: number;
    /** In-flight accounts whose `creditsReleased` differs from the ledger-received total. */
    inFlightLedgerMismatch: number;
    remainingToDrip: number;
  };
  dripCap: number;
  dripCapSource: SignupGrantDripCapSource;
}

type SizingUser = {
  _id: unknown;
  emailVerified?: boolean;
  isBanned?: boolean;
  isAdmin?: boolean;
  lastActiveAt?: Date;
  currentCredits?: number;
  tags?: string[];
  signupGrant?: SignupGrant;
};

const emptyBuckets = (): BucketCounts => ({ '<0': 0, '0': 0, '1': 0, '2-99': 0, '100-999': 0, '1000+': 0 });

export function bucketOf(value: number): Bucket {
  if (value < 0) return '<0';
  if (value === 0) return '0';
  if (value === 1) return '1';
  if (value < 100) return '2-99';
  if (value < 1000) return '100-999';
  return '1000+';
}

/**
 * Read-only sizing of the existing-account migration. Aggregate counts only: no ids, emails or
 * connection details are returned or logged. Received credits come from the ledger, not `currentCredits`.
 */
export async function buildSignupGrantSizingReport({
  now = new Date(),
}: { now?: Date } = {}): Promise<SignupGrantSizingReport> {
  const schedule = await resolveSignupGrantSchedule(adminSettingsRepository);
  const activeSince = new Date(now.getTime() - 30 * DAY_MS);

  const report: SignupGrantSizingReport = {
    generatedAt: now.toISOString(),
    users: { total: 0, withSignupGrant: 0, withoutSignupGrant: 0 },
    flatGrant: { verified: 0, unverified: 0, verifiedBalance: emptyBuckets(), verifiedReceived: emptyBuckets() },
    banned: 0,
    admins: 0,
    activeLast30Days: 0,
    pendingFreeCreditsTagged: 0,
    staged: {
      byStage: { pending_email: 0, signup: 0, unlocked: 0 },
      inFlight: 0,
      inFlightReceived: 0,
      inFlightLedgerMismatch: 0,
      remainingToDrip: 0,
    },
    dripCap: schedule.dripCap,
    dripCapSource: schedule.dripCapSource,
  };

  const cursor = User.collection
    .find(
      {},
      {
        projection: {
          emailVerified: 1,
          isBanned: 1,
          isAdmin: 1,
          lastActiveAt: 1,
          currentCredits: 1,
          tags: 1,
          signupGrant: 1,
        },
      }
    )
    .batchSize(LEDGER_BATCH_SIZE);

  let batch: SizingUser[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    const received = await readReceivedCredits(batch.map(user => String(user._id)));
    for (const user of batch) {
      const ledger = received.get(String(user._id)) ?? { received: 0, dripped: 0 };
      const grant = user.signupGrant;
      if (!grant) {
        if (user.emailVerified) {
          report.flatGrant.verified++;
          report.flatGrant.verifiedBalance[bucketOf(user.currentCredits ?? 0)]++;
          report.flatGrant.verifiedReceived[bucketOf(ledger.received)]++;
        } else {
          report.flatGrant.unverified++;
        }
        continue;
      }
      report.staged.byStage[grant.stage] = (report.staged.byStage[grant.stage] ?? 0) + 1;
      if (!signupGrantDripOpen(grant)) continue;
      report.staged.inFlight++;
      report.staged.inFlightReceived += ledger.received;
      if (grant.creditsReleased !== ledger.received) report.staged.inFlightLedgerMismatch++;
      report.staged.remainingToDrip += signupGrantDripRemaining({ dripCredits: ledger.dripped }, schedule.dripCap);
    }
    batch = [];
  };

  for await (const user of cursor as AsyncIterable<SizingUser>) {
    report.users.total++;
    if (user.signupGrant) report.users.withSignupGrant++;
    else report.users.withoutSignupGrant++;
    if (user.isBanned) report.banned++;
    else if (user.lastActiveAt && user.lastActiveAt >= activeSince) report.activeLast30Days++;
    if (user.isAdmin) report.admins++;
    if (user.tags?.includes(PENDING_FREE_CREDITS_TAG)) report.pendingFreeCreditsTagged++;
    batch.push(user);
    if (batch.length >= LEDGER_BATCH_SIZE) await flush();
  }
  await flush();
  return report;
}

export function formatSizingReport(report: SignupGrantSizingReport): string[] {
  const buckets = (counts: BucketCounts) => BUCKET_LABELS.map(label => `${label}:${counts[label]}`).join(' ');
  return [
    `Generated ${report.generatedAt}`,
    `Users: ${report.users.total} (${report.users.withSignupGrant} with signupGrant, ${report.users.withoutSignupGrant} without)`,
    `Flat grant (no signupGrant): ${report.flatGrant.verified} verified, ${report.flatGrant.unverified} unverified`,
    `  verified balance: ${buckets(report.flatGrant.verifiedBalance)}`,
    `  verified received (ledger): ${buckets(report.flatGrant.verifiedReceived)}`,
    `Banned: ${report.banned}; admins: ${report.admins}; non-banned active in the last 30 days: ${report.activeLast30Days}`,
    `Tagged ${PENDING_FREE_CREDITS_TAG}: ${report.pendingFreeCreditsTagged}`,
    `Staged by stage: pending_email ${report.staged.byStage.pending_email}, signup ${report.staged.byStage.signup}, unlocked ${report.staged.byStage.unlocked}`,
    `In flight (drip still open): ${report.staged.inFlight}, ledger-received total ${report.staged.inFlightReceived}, ` +
      `${report.staged.inFlightLedgerMismatch} with creditsReleased != ledger`,
    `Drip cap ${report.dripCap} (${report.dripCapSource}); remaining to drip across in-flight accounts: ${report.staged.remainingToDrip}`,
  ];
}
