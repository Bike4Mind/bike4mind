#!/usr/bin/env npx ts-node -r tsconfig-paths/register
import { signupProtectionRepository } from '@bike4mind/database';

/**
 * Grant the starting free credits to Google/GitHub signups that got none before OAuth signup
 * learned to grant them (see createOAuthUser.ts + verifyCallback.ts).
 *
 * Selection lives in oauthStartingGrantPlan.ts. An account qualifies only with a 0 balance, an
 * email the signup gate allows (not disposable, not on an admin-blocked domain), no pending-grant
 * tag and no credit ledger entry at all, so a re-run after --execute selects nobody. Internal accounts are excluded by NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS
 * (plus --exclude-email-domain) and the same test-email pattern as the external-users report.
 * The grant goes through userService.grantFreeCredits: same `verify-grant:<id>` transactionId as
 * the runtime paths, so it is recorded in the ledger and can never double-credit.
 *
 * Flags:
 *   --created-before=<ISO>         required; when the fix went live on this stage (prod lags main)
 *   --exclude-email-domain=<d>     repeatable; added to NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS
 *   --execute                      write; without it the run is a dry run
 *   --expect-amount=<n>            required with --execute; must equal resolved defaultFreeCredits
 *
 * Usage (inside an SST shell so Resource.MONGODB_URI resolves; staging's stage is `dev`):
 *   npx sst shell --stage production pnpm --filter @bike4mind/scripts backfill:oauth-starting-grant --created-before=<ISO>
 *   npx sst shell --stage production pnpm --filter @bike4mind/scripts backfill:oauth-starting-grant --created-before=<ISO> --execute --expect-amount=10000
 */

import {
  adminSettingsRepository,
  connectDB,
  CreditTransaction,
  creditLotRepository,
  creditTransactionRepository,
  userRepository,
} from '@bike4mind/database';
import { CreditHolderType, IUserDocument, internalStaffEmailRegex, parseInternalStaffDomains } from '@bike4mind/common';
import { userService } from '@bike4mind/services';
import { Resource } from 'sst';
import {
  buildPlan,
  parseBackfillArgs,
  STARTING_GRANT_STRATEGIES,
  type BackfillPlan,
  type StartingGrantUser,
} from './oauthStartingGrantPlan';
import { DEFAULT_TEST_PATTERN } from './src/externalActiveUsers';

const GRANT_REASON = 'backfill: OAuth signup before the starting-grant fix';

/** Only what classification reads; a full user doc carries login records, notes and counters. */
const USER_PROJECTION = {
  email: 1,
  createdAt: 1,
  currentCredits: 1,
  isAdmin: 1,
  isSystem: 1,
  isBanned: 1,
  tags: 1,
  'authProviders.strategy': 1,
  'oauthCredentials.strategy': 1,
};

const toDateOrNull = (value: unknown): Date | null => {
  if (value === null || value === undefined) return null;
  const date = new Date(value as string | number | Date);
  return Number.isNaN(date.getTime()) ? null : date;
};

const toStartingGrantUser = (user: IUserDocument): StartingGrantUser => ({
  id: user.id,
  email: user.email,
  createdAt: toDateOrNull(user.createdAt),
  currentCredits: user.currentCredits,
  isAdmin: user.isAdmin,
  isSystem: user.isSystem,
  isBanned: user.isBanned,
  tags: user.tags,
  authProviders: user.authProviders,
  oauthCredentials: user.oauthCredentials,
});

const findOAuthUsers = async (): Promise<StartingGrantUser[]> => {
  const users = await userRepository.find(
    {
      // Soft-deleted accounts are out of scope; same guard the user repository's own reads use.
      deletedAt: { $exists: false },
      $or: [
        { 'authProviders.strategy': { $in: STARTING_GRANT_STRATEGIES } },
        { 'oauthCredentials.strategy': { $in: STARTING_GRANT_STRATEGIES } },
      ],
    },
    USER_PROJECTION
  );
  return users.map(toStartingGrantUser);
};

/** Settings read failures throw and abort the run, rather than withholding grants silently. */
const findDisposableEmailUserIds = async (users: readonly StartingGrantUser[]): Promise<Set<string>> => {
  const shouldBlock = await userService.createSignupEmailGate(adminSettingsRepository);
  return new Set(users.filter(user => user.email && shouldBlock(user.email)).map(user => user.id));
};

/** Old ledger rows may carry only the deprecated `userId`, so both owner fields are checked. */
const findOwnersWithLedgerActivity = async (userIds: readonly string[]): Promise<Set<string>> => {
  if (userIds.length === 0) return new Set();
  const [byOwner, byLegacyUserId] = await Promise.all([
    CreditTransaction.distinct('ownerId', { ownerId: { $in: userIds }, ownerType: CreditHolderType.User }),
    CreditTransaction.distinct('userId', { userId: { $in: userIds } }),
  ]);
  return new Set([...byOwner, ...byLegacyUserId].map(String));
};

const printPlan = (scanned: number, plan: BackfillPlan): void => {
  console.log('Stats:');
  console.log(`  Google/GitHub users scanned: ${scanned}`);
  console.log(`  Eligible:                    ${plan.eligible.length}`);
  for (const [reason, count] of Object.entries(plan.skipped)) {
    console.log(`  Skipped (${reason}): ${count}`);
  }
  console.log('');
};

const describeUser = (user: StartingGrantUser): string =>
  `${user.id}  ${user.email ?? '<no-email>'}  created=${user.createdAt?.toISOString() ?? '<unknown>'}`;

const grantAll = async (users: readonly StartingGrantUser[]): Promise<{ granted: number; errors: number }> => {
  let granted = 0;
  let errors = 0;
  for (const user of users) {
    try {
      const result = await userService.grantFreeCredits(
        { id: user.id, pendingCreditGrant: null },
        {
          db: {
            adminSettings: adminSettingsRepository,
            creditTransactions: creditTransactionRepository,
            creditLots: creditLotRepository,
            users: userRepository,
            signupProtection: { repository: signupProtectionRepository, mode: 'enforce' },
          },
          reason: GRANT_REASON,
        }
      );
      if (result.withheld) {
        console.log(`  deferred ${describeUser(user)} - pending domain review`);
        continue;
      }
      granted++;
      console.log(`  ok  ${describeUser(user)}  +${result.creditsGranted} credits`);
    } catch (error) {
      errors++;
      console.error(`  ERR ${describeUser(user)}`, error instanceof Error ? error.message : error);
    }
  }
  return { granted, errors };
};

const run = async (): Promise<number> => {
  const args = parseBackfillArgs(process.argv.slice(2));
  const stage = Resource.App.stage;
  const internalDomains = [
    ...parseInternalStaffDomains(process.env.NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS),
    ...args.extraInternalDomains,
  ];

  console.log('BACKFILL OAUTH STARTING GRANT');
  console.log(`Stage:          ${stage}`);
  console.log(`Mode:           ${args.execute ? 'EXECUTE (will modify database)' : 'DRY RUN'}`);
  console.log(`Created before: ${args.createdBefore.toISOString()}`);
  console.log(`Internal email domains: ${internalDomains.join(', ') || '<none>'}`);
  console.log('');

  if (internalDomains.length === 0) {
    console.warn('WARNING: no internal email domain configured; staff accounts are excluded only if admin.');
    if (args.execute) {
      console.error(
        'Aborting: set NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS or pass --exclude-email-domain before --execute.'
      );
      return 1;
    }
  }

  await connectDB(Resource.MONGODB_URI.value.replace('%STAGE%', stage));

  const amount = await userService.resolveFreeCreditAmount(null, adminSettingsRepository);
  console.log(`defaultFreeCredits (admin setting): ${amount}`);
  if (args.execute && amount !== args.expectAmount) {
    console.error(`Aborting: defaultFreeCredits is ${amount}, but --expect-amount=${args.expectAmount}.`);
    return 1;
  }
  console.log('');

  const users = await findOAuthUsers();
  const plan = await buildPlan(
    users,
    {
      createdBefore: args.createdBefore,
      internalEmail: internalStaffEmailRegex(internalDomains),
      testEmail: new RegExp(DEFAULT_TEST_PATTERN, 'i'),
    },
    { findDisposableEmailUserIds, findOwnersWithLedgerActivity }
  );
  printPlan(users.length, plan);

  if (plan.eligible.length === 0) {
    console.log('Nothing to backfill.');
    return 0;
  }

  if (!args.execute) {
    console.log('Eligible users:');
    plan.eligible.forEach(user => console.log(`  ${describeUser(user)}`));
    console.log('');
    console.log('DRY RUN: no changes made. Re-run with --execute --expect-amount=<credits> to apply.');
    return 0;
  }

  const { granted, errors } = await grantAll(plan.eligible);
  console.log('');
  console.log(`Granted: ${granted}  Errors: ${errors}`);
  console.log('Re-run without --execute to confirm nobody is left eligible.');
  return errors > 0 ? 1 : 0;
};

run()
  .then(code => process.exit(code))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
