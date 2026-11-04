import { writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  resolveSignupGrantSchedule,
  signupGrantDripOpen,
  signupGrantDripRemaining,
  type SignupGrant,
} from '@bike4mind/common';
import { adminSettingsRepository, User } from '@bike4mind/database';
import mongoose from 'mongoose';
import { LEDGER_BATCH_SIZE, readReceivedCredits } from './signupGrantLedger';

export type SkipReason = 'already-aligned' | 'invalid-grant' | 'ledger-below-state';

export interface MigrationOptions {
  /** Default false: report the plan and write nothing. */
  apply?: boolean;
  /** Required with `apply`: refuse to write when more accounts than this would change. */
  maxUsers?: number;
  /** Required with `apply`: refuse to write when the changed accounts could still drip more than this in total. */
  maxCredits?: number;
  /**
   * JSON file recording every planned change (user id, before, after), written before any write.
   * Created with mode 0600; an existing file is refused rather than overwritten.
   */
  reportPath?: string;
  log?: (message: string) => void;
}

interface GrantFields {
  creditsReleased: number;
  dripCredits: number | null;
  unlockCredits: number;
}

export interface PlannedChange {
  userId: string;
  stage: SignupGrant['stage'];
  before: GrantFields;
  after: GrantFields;
  /** Drip headroom the account keeps under the live cap after the change. */
  remainingToDrip: number;
}

export interface MigrationResult {
  dripCap: number;
  inFlight: number;
  /** Staged accounts left alone: flat-grant, signup not yet paid, closed, or in an excluded account state. */
  skipped: { flatGrant: number; notInFlight: number; excluded: number } & Record<SkipReason, number>;
  changes: PlannedChange[];
  /** Total drip headroom of the accounts that change; what `maxCredits` bounds. */
  remainingToDrip: number;
  /** Accounts actually written (0 on a dry run). */
  migrated: number;
}

/** Account states the drip never pays into: isReleaseEligible's blocked and AI-revoked states in stagedSignupGrant.ts, plus deleted. */
const NOT_BLOCKED = {
  isBanned: { $ne: true },
  isModerated: { $ne: true },
  disputePending: { $ne: true },
  'moderation.status': { $ne: 'suspended' },
  deletedAt: null,
};

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** `--max-users` and `--max-credits` take a positive integer, as `--flag n` or `--flag=n`. */
function positiveIntegerArg(argv: string[], flag: string): number | undefined {
  const index = argv.findIndex(arg => arg === flag || arg.startsWith(`${flag}=`));
  if (index === -1) return undefined;
  const raw = argv[index].startsWith(`${flag}=`) ? argv[index].slice(flag.length + 1) : argv[index + 1];
  const value = Number(raw);
  if (!raw || !Number.isSafeInteger(value) || value < 1) throw new Error(`${flag} needs a positive integer`);
  return value;
}

/**
 * CLI args for migrate-signup-grant-schedule.ts. The report holds production user ids, so it defaults to
 * the OS temp dir (never the checkout). `--apply` needs both caps so a write is always bounded.
 */
export function parseMigrationArgs(
  argv: string[]
): Required<Pick<MigrationOptions, 'apply' | 'reportPath'>> & Pick<MigrationOptions, 'maxUsers' | 'maxCredits'> {
  const apply = argv.includes('--apply');
  const maxUsers = positiveIntegerArg(argv, '--max-users');
  const maxCredits = positiveIntegerArg(argv, '--max-credits');
  if (apply && (maxUsers === undefined || maxCredits === undefined)) {
    throw new Error('--apply requires --max-users and --max-credits');
  }
  const reportArg = argv.find(arg => arg === '--report' || arg.startsWith('--report='));
  let reportPath: string | undefined;
  if (reportArg === undefined) {
    reportPath = join(tmpdir(), `signup-grant-schedule-${Date.now()}.json`);
  } else if (reportArg.startsWith('--report=')) {
    reportPath = reportArg.slice('--report='.length);
  } else {
    reportPath = argv[argv.indexOf('--report') + 1];
  }
  if (!reportPath || reportPath.startsWith('--')) throw new Error('--report needs a file path');
  return { apply, maxUsers, maxCredits, reportPath };
}

type StagedUser = { _id: mongoose.Types.ObjectId; signupGrant: SignupGrant };

/**
 * Brings accounts that are still mid-drip onto the live schedule from what they actually received: the
 * grant's `creditsReleased` and `dripCredits` are set to the ledger totals, so the drip pays the live cap
 * minus what was dripped. Flat-grant accounts (no `signupGrant`) and accounts the drip cannot pay
 * (banned, moderated, disputed, suspended, deleted) are never touched.
 *
 * Only ever raises what an account is recorded as having received: a ledger total below the recorded
 * state is reported and skipped rather than lowered, since lowering would reopen credits already paid.
 * Idempotent: an aligned account is skipped, so a second run finds nothing. Each write is guarded on the
 * values read, so an account that changed since the plan (a drip landing) is left for the next run.
 */
export async function migrateSignupGrantSchedule({
  apply = false,
  maxUsers,
  maxCredits,
  reportPath,
  log = console.log,
}: MigrationOptions = {}): Promise<MigrationResult> {
  if (apply && (maxUsers === undefined || maxCredits === undefined)) {
    throw new Error('--apply requires --max-users and --max-credits');
  }
  const { dripCap } = await resolveSignupGrantSchedule(adminSettingsRepository);

  const result: MigrationResult = {
    dripCap,
    inFlight: 0,
    skipped: {
      flatGrant: 0,
      notInFlight: 0,
      excluded: 0,
      'already-aligned': 0,
      'invalid-grant': 0,
      'ledger-below-state': 0,
    },
    changes: [],
    remainingToDrip: 0,
    migrated: 0,
  };

  result.skipped.flatGrant = await User.collection.countDocuments({ signupGrant: { $exists: false } });
  result.skipped.excluded = await User.collection.countDocuments({
    'signupGrant.stage': { $in: ['signup', 'unlocked'] },
    $nor: [NOT_BLOCKED],
  });
  result.skipped.notInFlight = await User.collection.countDocuments({
    'signupGrant.stage': 'pending_email',
  });

  const cursor = User.collection
    .find({ 'signupGrant.stage': { $in: ['signup', 'unlocked'] }, ...NOT_BLOCKED }, { projection: { signupGrant: 1 } })
    .batchSize(LEDGER_BATCH_SIZE);

  let batch: StagedUser[] = [];
  const plan = async () => {
    if (batch.length === 0) return;
    const received = await readReceivedCredits(batch.map(user => String(user._id)));
    for (const user of batch) {
      const grant = user.signupGrant;
      if (!signupGrantDripOpen(grant)) {
        result.skipped.notInFlight++;
        continue;
      }
      result.inFlight++;
      const userId = String(user._id);
      const ledger = received.get(userId) ?? { received: 0, dripped: 0 };
      const recordedDrip = grant.dripCredits ?? 0;
      if (
        ![grant.signupCredits, grant.unlockCredits, grant.creditsReleased, recordedDrip].every(isCount) ||
        grant.creditsReleased > grant.signupCredits + grant.unlockCredits
      ) {
        result.skipped['invalid-grant']++;
        continue;
      }
      if (ledger.received < grant.creditsReleased || ledger.dripped < recordedDrip) {
        result.skipped['ledger-below-state']++;
        continue;
      }
      // The pool only grows to hold what was already received; no credit is paid by this change.
      const unlockCredits = Math.max(grant.unlockCredits, ledger.received - grant.signupCredits);
      const after: GrantFields = { creditsReleased: ledger.received, dripCredits: ledger.dripped, unlockCredits };
      const before: GrantFields = {
        creditsReleased: grant.creditsReleased,
        dripCredits: grant.dripCredits ?? null,
        unlockCredits: grant.unlockCredits,
      };
      const aligned =
        after.creditsReleased === before.creditsReleased &&
        after.unlockCredits === before.unlockCredits &&
        (after.dripCredits === before.dripCredits || (before.dripCredits === null && after.dripCredits === 0));
      if (aligned) {
        result.skipped['already-aligned']++;
        continue;
      }
      const remainingToDrip = signupGrantDripRemaining({ dripCredits: ledger.dripped }, dripCap);
      result.changes.push({ userId, stage: grant.stage, before, after, remainingToDrip });
      result.remainingToDrip += remainingToDrip;
    }
    batch = [];
  };

  for await (const user of cursor as AsyncIterable<StagedUser>) {
    batch.push(user);
    if (batch.length >= LEDGER_BATCH_SIZE) await plan();
  }
  await plan();

  if (reportPath) {
    writeFileSync(
      reportPath,
      JSON.stringify({ apply, dripCap, skipped: result.skipped, changes: result.changes }, null, 2),
      {
        mode: 0o600,
        flag: 'wx',
      }
    );
    log(`Wrote the planned changes to ${reportPath}.`);
  }

  if (apply) {
    if (result.changes.length > maxUsers!) {
      throw new Error(
        `Refusing to write: ${result.changes.length} accounts would change, over --max-users ${maxUsers}`
      );
    }
    if (result.remainingToDrip > maxCredits!) {
      throw new Error(
        `Refusing to write: the changed accounts could drip ${result.remainingToDrip} more credits, over --max-credits ${maxCredits}`
      );
    }
    for (const change of result.changes) {
      const guard: Record<string, unknown> = {
        _id: new mongoose.Types.ObjectId(change.userId),
        'signupGrant.stage': change.stage,
        'signupGrant.creditsReleased': change.before.creditsReleased,
        'signupGrant.unlockCredits': change.before.unlockCredits,
        // null matches both a missing and a stored-null field.
        'signupGrant.dripCredits': change.before.dripCredits ?? null,
        ...NOT_BLOCKED,
      };
      const written = await User.collection.updateOne(guard, {
        $set: {
          'signupGrant.creditsReleased': change.after.creditsReleased,
          'signupGrant.dripCredits': change.after.dripCredits,
          'signupGrant.unlockCredits': change.after.unlockCredits,
        },
      });
      result.migrated += written.modifiedCount;
    }
    if (result.migrated < result.changes.length) {
      log(`Wrote ${result.migrated} of ${result.changes.length} planned account(s); the rest changed since the plan.`);
    }
  }

  const { skipped } = result;
  log(
    `Drip cap ${dripCap}. In flight: ${result.inFlight}; to change: ${result.changes.length} ` +
      `(remaining to drip ${result.remainingToDrip}). Skipped: ${skipped.flatGrant} flat-grant, ` +
      `${skipped.notInFlight} not in flight, ${skipped.excluded} excluded, ${skipped['already-aligned']} aligned, ` +
      `${skipped['invalid-grant']} invalid, ${skipped['ledger-below-state']} ledger-below-state` +
      (apply ? `; migrated ${result.migrated}.` : '.')
  );
  return result;
}
