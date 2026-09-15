#!/usr/bin/env npx ts-node -r tsconfig-paths/register

import { connectDB, userRepository } from '@bike4mind/database';
import { IUserDocument } from '@bike4mind/common';
import { Resource } from 'sst';

type MigrationOptions = {
  dbUri: string;
  stage: string;
  dryRun: boolean;
};

/**
 * Migration script to mark all existing users as email verified
 *
 * This implements the "grandfather clause" strategy - all users created before
 * the email verification feature was implemented are automatically marked as verified.
 *
 * Sets the following fields for grandfathered users:
 * - emailVerified: true
 * - emailVerifiedAt: migration cutoff date
 * - emailVerificationUsed: null (not applicable)
 * - pendingEmailUsed: null (initialize for future email changes)
 *
 * Usage:
 * - Dry run (preview changes): npx ts-node migrateEmailVerification.ts
 * - Execute migration: npx ts-node migrateEmailVerification.ts --execute
 */
class EmailVerificationMigration {
  private options: MigrationOptions;
  private cutoffDate: Date;

  constructor(options: Pick<MigrationOptions, 'dbUri' | 'stage'>) {
    if (options.dbUri === undefined) throw new Error('MONGODB_URI env variable is required');
    if (options.stage === undefined) console.warn('STAGE env variable is not set.');

    const dryRun = !process.argv.includes('--execute');
    this.options = {
      dryRun,
      ...options,
    };

    // Cutoff date: when this migration is run
    // Users created before this date are marked as verified
    this.cutoffDate = new Date();
  }

  public async run() {
    try {
      console.log('📧 EMAIL VERIFICATION MIGRATION');
      console.log('===============================');
      console.log('Database URI:', this.options.dbUri.replace('%STAGE%', this.options.stage));
      console.log('Stage:', this.options.stage);
      console.log('Mode:', this.options.dryRun ? 'DRY RUN (preview only)' : 'EXECUTE (will modify database)');
      console.log('Cutoff Date:', this.cutoffDate.toISOString());
      console.log('');

      console.log('🔌 Connecting to database...');
      await connectDB(this.options.dbUri.replace('%STAGE%', this.options.stage));
      console.log('✅ Database connected successfully');
      console.log('');

      console.log('🔍 Finding users to migrate...');
      const users = await userRepository.find({});

      // Filter users that need migration:
      // - Have an email address
      // - Email is not verified yet (or field doesn't exist)
      // - Created before cutoff date
      const usersToMigrate = users.filter((user: IUserDocument) => {
        const hasEmail = !!user.email;
        const isNotVerified = !user.emailVerified;
        const createdBeforeCutoff = user.createdAt ? new Date(user.createdAt) < this.cutoffDate : true;

        return hasEmail && isNotVerified && createdBeforeCutoff;
      });

      console.log(`📊 Migration Statistics:`);
      console.log(`   Total users: ${users.length}`);
      console.log(`   Users to migrate: ${usersToMigrate.length}`);
      console.log(`   Already verified: ${users.filter((u: IUserDocument) => u.emailVerified).length}`);
      console.log(`   No email address: ${users.filter((u: IUserDocument) => !u.email).length}`);
      console.log('');

      if (usersToMigrate.length === 0) {
        console.log('✅ No users need migration. All done!');
        return 0;
      }

      if (this.options.dryRun) {
        console.log('🔍 DRY RUN: Preview of users that would be migrated:');
        console.log('');
        usersToMigrate.slice(0, 10).forEach((user: IUserDocument) => {
          console.log(`   - ${user.username} (${user.email}) - Created: ${user.createdAt}`);
        });
        if (usersToMigrate.length > 10) {
          console.log(`   ... and ${usersToMigrate.length - 10} more users`);
        }
        console.log('');
        console.log('⚠️  This was a DRY RUN - no changes were made to the database.');
        console.log('To execute the migration, run with --execute flag:');
        console.log('   npx ts-node migrateEmailVerification.ts --execute');
        return 0;
      }

      // Execute migration
      console.log('⚡ Executing migration...');
      let successCount = 0;
      let errorCount = 0;

      for (const user of usersToMigrate) {
        try {
          await userRepository.update({
            id: user.id,
            emailVerified: true,
            emailVerifiedAt: this.cutoffDate,
            emailVerificationUsed: null, // Not applicable for grandfathered users
            pendingEmailUsed: null, // Initialize for future email changes
          });
          successCount++;

          if (successCount % 100 === 0) {
            console.log(`   Progress: ${successCount}/${usersToMigrate.length} users migrated...`);
          }
        } catch (error) {
          errorCount++;
          console.error(`   ❌ Error migrating user ${user.username}:`, error);
        }
      }

      console.log('');
      console.log('✅ Migration complete!');
      console.log(`   Successfully migrated: ${successCount}`);
      console.log(`   Errors: ${errorCount}`);
      console.log('');

      if (errorCount > 0) {
        console.warn('⚠️  Some users failed to migrate. Please review the errors above.');
        return 1;
      }

      return 0;
    } catch (error) {
      console.error('❌ Migration failed:', error);
      console.error('Error details:', error instanceof Error ? error.message : String(error));
      return 1;
    } finally {
      process.exit(0);
    }
  }
}

new EmailVerificationMigration({
  dbUri: Resource.MONGODB_URI.value,
  stage: Resource.App.stage,
})
  .run()
  .then((exitCode: number) => process.exit(exitCode))
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
