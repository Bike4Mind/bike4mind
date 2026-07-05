#!/usr/bin/env npx tsx

import { connectDB, userRepository } from '@bike4mind/database';
import { IUserDocument } from '@bike4mind/common';
import { Resource } from 'sst';

async function verifyMigration() {
  const dbUri = Resource.MONGODB_URI.value;

  await connectDB(dbUri);

  // Get a sample of migrated users
  const users = await userRepository.find({ emailVerified: true });
  console.log('\n📊 Verification Status Check');
  console.log('=============================');
  console.log(`Total verified users: ${users.length}`);
  console.log('\nSample of migrated users (first 5):');
  users.slice(0, 5).forEach((user: IUserDocument) => {
    console.log(`  - ${user.username} (${user.email})`);
    console.log(`    emailVerified: ${user.emailVerified}`);
    console.log(`    emailVerifiedAt: ${user.emailVerifiedAt}`);
    console.log(`    emailVerificationUsed: ${user.emailVerificationUsed}`);
    console.log(`    pendingEmailUsed: ${user.pendingEmailUsed}`);
    console.log('');
  });

  process.exit(0);
}

verifyMigration().catch(e => {
  console.error(e);
  process.exit(1);
});
