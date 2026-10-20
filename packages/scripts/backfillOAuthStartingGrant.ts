#!/usr/bin/env npx ts-node -r tsconfig-paths/register

/**
 * Grant the starting free credits to Google/GitHub signups that got none before OAuth signup
 * learned to grant them (see createOAuthUser.ts + verifyCallback.ts).
 *
 * Selection lives in oauthStartingGrantPlan.ts. An account qualifies only with a 0 balance, no
 * pending-grant tag, and no credit ledger entry at all, so a re-run after --execute selects nobody.
 * The grant goes through userService.grantFreeCredits: same `verify-grant:<id>` transactionId as
 * the runtime paths, so it is recorded in the ledger and can never double-credit.
 *
 * Flags:
 *   --created-before=<ISO>         required; when the fix went live on this stage (prod lags main)
 *   --exclude-email-domain=<d>     repeatable; added to the default internal domains
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
import { CreditHolderType, IUserDocument } from '@bike4mind/common';
import { userService } from '@bike4mind/services';
import { Resource } from 'sst';
import {
  parseBackfillArgs,
  planBackfill,
  STARTING_GRANT_STRATEGIES,
  type BackfillArgs,
  type BackfillPlan,
  type PlanContext,
  type StartingGrantUser,
} from './oauthStartingGrantPlan';

const GRANT_REASON = 'backfill: OAuth signup before the starting-grant fix';

const toStartingGrantUser = (user: IUserDocument): StartingGrantUser => ({
  id: user.id,
  email: user.email,
  createdAt: new Date(user.createdAt),
  currentCredits: user.currentCredits,
  isAdmin: user.isAdmin,
  isSystem: user.isSystem,
  tags: user.tags,
  authProviders: user.authProviders,
  oauthCredentials: user.oauthCredentials,
});

const findOAuthUsers = async (): Promise<StartingGrantUser[]> => {
  const users = await userRepository.find({
    $or: [
      { 'authProviders.strategy': { $in: STARTING_GRANT_STRATEGIES } },
      { 'oauthCredentials.strategy': { $in: STARTING_GRANT_STRATEGIES } },
    ],
  });
  return users.map(toStartingGrantUser);
};

const findOwnersWithLedgerActivity = async (userIds: readonly string[]): Promise<Set<string>> => {
  if (userIds.length === 0) return new Set();
  const owners: string[] = await CreditTransaction.distinct('ownerId', {
    ownerId: { $in: userIds },
    ownerType: CreditHolderType.User,
  });
  return new Set(owners);
};

/** Ledger lookup is the expensive check, so it runs only for users that pass every other one. */
const buildPlan = async (users: readonly StartingGrantUser[], args: BackfillArgs): Promise<BackfillPlan> => {
  const baseContext: Omit<PlanContext, 'ownersWithLedgerActivity'> = {
    createdBefore: args.createdBefore,
    excludedEmailDomains: args.excludedEmailDomains,
  };
  const preliminary = planBackfill(users, { ...baseContext, ownersWithLedgerActivity: new Set() });
  const ownersWithLedgerActivity = await findOwnersWithLedgerActivity(preliminary.eligible.map(user => user.id));
  return planBackfill(users, { ...baseContext, ownersWithLedgerActivity });
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
  `${user.id}  ${user.email ?? '<no-email>'}  created=${user.createdAt.toISOString()}`;

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
          },
          reason: GRANT_REASON,
        }
      );
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

  console.log('BACKFILL OAUTH STARTING GRANT');
  console.log(`Stage:          ${stage}`);
  console.log(`Mode:           ${args.execute ? 'EXECUTE (will modify database)' : 'DRY RUN'}`);
  console.log(`Created before: ${args.createdBefore.toISOString()}`);
  console.log(`Excluded email domains: ${args.excludedEmailDomains.join(', ')}`);
  console.log('');

  await connectDB(Resource.MONGODB_URI.value.replace('%STAGE%', stage));

  const amount = await userService.resolveFreeCreditAmount(null, adminSettingsRepository);
  console.log(`defaultFreeCredits (admin setting): ${amount}`);
  if (args.execute && amount !== args.expectAmount) {
    console.error(`Aborting: defaultFreeCredits is ${amount}, but --expect-amount=${args.expectAmount}.`);
    return 1;
  }
  console.log('');

  const users = await findOAuthUsers();
  const plan = await buildPlan(users, args);
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
