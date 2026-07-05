#!/usr/bin/env npx ts-node -r tsconfig-paths/register

import { adminSettingsRepository, connectDB, creditTransactionRepository, userRepository } from '@bike4mind/database';
import { CreditHolderType, IUserDocument, PENDING_FREE_CREDITS_TAG, settingsMap } from '@bike4mind/common';
import { creditService } from '@bike4mind/services';
import { Resource } from 'sst';

type BackfillOptions = {
  dbUri: string;
  stage: string;
  dryRun: boolean;
};

/**
 * Backfill credits for users stranded by the pre-c2c1b5e6 email-verify atomicity bug.
 *
 * Background:
 *   A bug in BaseRepository.update caused withTransaction blocks
 *   to NOT be atomic across multiple writes. In the email-verify flow this could
 *   leave a user with `emailVerified=true` but `currentCredits=0` and the
 *   `pending-free-credits` tag still present - verified but stranded with no working
 *   retry path.
 *
 * What this does:
 *   Finds every user with `emailVerified=true` AND `pending-free-credits` in tags,
 *   grants them their invite-resolved `pendingCreditGrant` when set - else
 *   `defaultFreeCredits` (read from admin settings at script run time) - clears both
 *   the tag and the pending amount. Idempotent - re-runs are safe because `addCredits` is keyed
 *   on a stable `transactionId='verify-grant:${user.id}'` (matches the runtime grant
 *   path in apps/client/pages/api/email/verify.ts).
 *
 * Usage (must run inside an SST shell so Resource.MONGODB_URI resolves):
 *   Dry run on PR preview:   npx sst shell --stage pr8958 pnpm --filter @bike4mind/scripts backfill:pending-free-credits
 *   Execute on PR preview:   npx sst shell --stage pr8958 pnpm --filter @bike4mind/scripts backfill:pending-free-credits --execute
 *   Dry run on staging:      npx sst shell --stage dev      pnpm --filter @bike4mind/scripts backfill:pending-free-credits
 *   Execute on staging:      npx sst shell --stage dev      pnpm --filter @bike4mind/scripts backfill:pending-free-credits --execute
 *   Dry run on prod:         npx sst shell --stage production pnpm --filter @bike4mind/scripts backfill:pending-free-credits
 *   Execute on prod:         npx sst shell --stage production pnpm --filter @bike4mind/scripts backfill:pending-free-credits --execute
 *
 * NOTE: staging's SST stage is `dev` (not `staging`). See CLAUDE.md for the stage->env mapping.
 */
class BackfillPendingFreeCredits {
  private options: BackfillOptions;

  constructor(options: Pick<BackfillOptions, 'dbUri' | 'stage'>) {
    if (options.dbUri === undefined) throw new Error('MONGODB_URI is required');
    if (options.stage === undefined) console.warn('STAGE is not set.');

    this.options = {
      ...options,
      dryRun: !process.argv.includes('--execute'),
    };
  }

  public async run(): Promise<number> {
    console.log('🪪  BACKFILL PENDING-FREE-CREDITS');
    console.log('================================');
    console.log('Stage:', this.options.stage);
    console.log('Mode:', this.options.dryRun ? 'DRY RUN (preview only)' : 'EXECUTE (will modify database)');
    console.log('');

    console.log('🔌 Connecting to database...');
    await connectDB(this.options.dbUri.replace('%STAGE%', this.options.stage));
    console.log('✅ Database connected');
    console.log('');

    // Resolve defaultFreeCredits through the canonical Zod-parsed read so we accept
    // both the boolean/numeric-stored form and any legacy string-stored value.
    const setting = await adminSettingsRepository.findBySettingName('defaultFreeCredits');
    const parsed = settingsMap.defaultFreeCredits.schema.safeParse(setting?.settingValue);
    const amount = parsed.success ? parsed.data : 0;
    console.log(`📐 defaultFreeCredits (admin setting): ${amount}`);
    if (amount <= 0) {
      console.warn(
        '⚠️  defaultFreeCredits is 0 — no credits will be granted. The tag will still be cleared on --execute.'
      );
    }
    console.log('');

    console.log('🔍 Finding stranded users...');
    // Note: userRepository.find returns ALL users with no native filter on tag array
    // membership - we filter in-process to keep the script independent of repo internals.
    const allUsers = await userRepository.find({});
    const stranded = allUsers.filter(
      (u: IUserDocument) =>
        u.emailVerified === true && Array.isArray(u.tags) && u.tags.includes(PENDING_FREE_CREDITS_TAG)
    );

    console.log(`📊 Stats:`);
    console.log(`   Total users scanned: ${allUsers.length}`);
    console.log(`   Stranded (verified + pending tag): ${stranded.length}`);
    console.log('');

    if (stranded.length === 0) {
      console.log('✅ Nothing to backfill. All good.');
      return 0;
    }

    if (this.options.dryRun) {
      console.log('🔍 DRY RUN — users that would be backfilled:');
      stranded.slice(0, 20).forEach((u: IUserDocument) => {
        console.log(
          `   - ${u.id}  ${u.username ?? '<no-username>'}  ${u.email ?? '<no-email>'}  credits=${u.currentCredits ?? 0}`
        );
      });
      if (stranded.length > 20) {
        console.log(`   ... and ${stranded.length - 20} more`);
      }
      console.log('');
      console.log('⚠️  DRY RUN — no changes made. Re-run with --execute to apply.');
      return 0;
    }

    console.log('⚡ Executing backfill...');
    let granted = 0;
    let tagCleared = 0;
    let errors = 0;

    for (const user of stranded) {
      try {
        // An invite-resolved amount stored on the user wins over the setting;
        // mirrors the runtime grant paths (registerViaOTC / email verify).
        const userAmount = user.pendingCreditGrant ?? amount;
        if (userAmount > 0) {
          await creditService.addCredits(
            {
              ownerId: user.id,
              ownerType: CreditHolderType.User,
              credits: userAmount,
              type: 'generic_add',
              // Stable transactionId - matches the runtime verify-grant path. If a user
              // was already granted credits through another path (e.g. a partial recovery),
              // this short-circuits to a net-zero increment instead of double-crediting.
              transactionId: `verify-grant:${user.id}`,
              reason: 'backfill: stranded by pre-c2c1b5e6 verify atomicity bug',
            },
            { db: { creditTransactions: creditTransactionRepository }, creditHolderMethods: userRepository }
          );
          granted++;
        }

        await userRepository.update({
          id: user.id,
          pendingCreditGrant: null,
          tags: (user.tags ?? []).filter(t => t !== PENDING_FREE_CREDITS_TAG),
        });
        tagCleared++;

        console.log(
          `   ✓ ${user.id}  ${user.email ?? '<no-email>'}  ${userAmount > 0 ? `+${userAmount} credits` : 'tag cleared (amount=0)'}`
        );
      } catch (error) {
        errors++;
        console.error(
          `   ✗ ${user.id}  ${user.email ?? '<no-email>'}  ERROR:`,
          error instanceof Error ? error.message : error
        );
      }
    }

    console.log('');
    console.log('✅ Backfill complete!');
    console.log(`   Credits granted: ${granted}`);
    console.log(`   Tags cleared:    ${tagCleared}`);
    console.log(`   Errors:          ${errors}`);
    return errors > 0 ? 1 : 0;
  }
}

new BackfillPendingFreeCredits({
  dbUri: Resource.MONGODB_URI.value,
  stage: Resource.App.stage,
})
  .run()
  .then(code => process.exit(code))
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
