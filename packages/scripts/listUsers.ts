#!/usr/bin/env tsx

import { connectDB, User } from '@bike4mind/database';
import * as dotenv from 'dotenv';
import { Resource } from 'sst';

dotenv.config({ path: '../../.env' });

async function listUsers() {
  try {
    // Try to get stage from SST Resource, fallback to environment variable
    let stage: string;
    try {
      stage = Resource.App.stage;
    } catch (error) {
      stage = process.env.STAGE || 'development';
      console.log(`⚠️  SST context not available, using STAGE from environment: ${stage}`);
    }

    const dbUri = process.env.MONGODB_URI;
    if (!dbUri) {
      throw new Error('MONGODB_URI environment variable is required');
    }

    console.log('🔧 Connecting to database...');
    console.log('🔧 Database URI:', dbUri.replace('%STAGE%', stage));
    console.log('🔧 Stage:', stage);

    await connectDB(dbUri.replace('%STAGE%', stage));
    console.log('✅ Connected to database\n');

    // Get all users (including password field which is normally excluded)
    const users = await User.find({}).select('+password').lean();

    if (!users || users.length === 0) {
      console.log('❌ No users found in database');
      return 0;
    }

    console.log(`📋 Found ${users.length} user(s):\n`);
    console.log('═'.repeat(100));

    users.forEach((user: any, index: number) => {
      console.log(`\n${index + 1}. User Details:`);
      console.log('─'.repeat(100));
      console.log(`   ID:              ${user._id || user.id}`);
      console.log(`   Username:        ${user.username}`);
      console.log(`   Email:           ${user.email}`);
      console.log(`   Name:            ${user.name || 'N/A'}`);
      console.log(`   Is Admin:        ${user.isAdmin ? '✅ YES' : '❌ NO'}`);
      console.log(`   Is Banned:       ${user.isBanned ? '⚠️  YES' : '✅ NO'}`);
      console.log(`   Has Password:    ${user.password ? '✅ YES' : '❌ NO'}`);
      console.log(`   Password Hash:   ${user.password ? user.password.substring(0, 30) + '...' : 'N/A'}`);
      console.log(`   Level:           ${user.level || 'N/A'}`);
      console.log(`   Tags:            ${user.tags?.join(', ') || 'None'}`);
      console.log(`   Credits:         ${user.currentCredits || 0}`);
      console.log(`   Storage:         ${user.currentStorageSize || 0} / ${user.storageLimit || 0} MB`);
      console.log(`   Auth Providers:  ${user.authProviders?.map((p: any) => p.strategy).join(', ') || 'None'}`);
      console.log(`   Created:         ${user.createdAt || 'Unknown'}`);
      console.log(`   Login Records:   ${user.loginRecords?.length || 0} login(s)`);

      if (user.mfa) {
        console.log(`   MFA:             ✅ Enabled`);
      }

      console.log('─'.repeat(100));
    });

    console.log('\n═'.repeat(100));
    console.log(`\n✅ Total users: ${users.length}`);

    return 0;
  } catch (error) {
    console.error('❌ Error listing users:', error);
    console.error('❌ Error details:', error instanceof Error ? error.message : String(error));
    return 1;
  }
}

listUsers()
  .then((exitCode: number) => process.exit(exitCode))
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
