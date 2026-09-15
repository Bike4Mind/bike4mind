#!/usr/bin/env tsx
/**
 * Set up test user for email ingestion testing
 *
 * Usage:
 *   pnpm run db:setup-email-user <email> <platformEmail>
 *   npx tsx setupTestEmailUser.ts <email> <platformEmail>
 *
 * Example:
 *   pnpm run db:setup-email-user alice@example.com alice.anderson@app.example.com
 *   npx tsx setupTestEmailUser.ts alice@example.com alice.anderson@app.example.com
 */

import { User, connectDB } from '@bike4mind/database';
import mongoose from 'mongoose';
import { Config } from './utils/config';

async function setupTestEmailUser(email: string, platformEmail: string) {
  const mongoUri = Config.MONGODB_URI;

  if (!mongoUri) {
    console.error('❌ MONGODB_URI is not configured');
    console.error('   Make sure your SST secrets are set up.');
    process.exit(1);
  }

  console.log('Connecting to MongoDB...');
  await connectDB(mongoUri);
  console.log('✅ Connected to MongoDB\n');

  // Find user by email
  const user = await User.findOne({ email });

  if (!user) {
    console.error(`❌ User with email ${email} not found`);
    console.error('\nAvailable users:');
    const users = await User.find({}, { email: 1, username: 1 }).limit(10);
    users.forEach(u => {
      console.error(`   - ${u.username} (${u.email})`);
    });
    process.exit(1);
  }

  console.log(`✅ Found user: ${user.username} (${user.email})`);
  console.log(`   User ID: ${user._id}`);

  // Update user with platform email and authorized sender
  user.platformEmailAddress = platformEmail;

  // Add email to authorized list if not already there
  if (!user.authorizedEmailAddresses) {
    user.authorizedEmailAddresses = [];
  }

  if (!user.authorizedEmailAddresses.includes(email)) {
    user.authorizedEmailAddresses.push(email);
  }

  await user.save();

  console.log('\n✅ User updated successfully!');
  console.log(`   Platform Email: ${user.platformEmailAddress}`);
  console.log(`   Authorized Senders: ${user.authorizedEmailAddresses.join(', ')}`);
  console.log('\n📧 Ready to test! You can now:');
  console.log('   1. Run the test script:');
  console.log('      pnpm run test:email-ingestion --quick');
  console.log('\n   2. Or send a real email to AWS SES:');
  console.log(`      From: ${email}`);
  console.log(`      To: ${platformEmail}`);
  console.log(`      Subject: Test Email Ingestion`);

  await mongoose.disconnect();
  console.log('\n✅ Done!\n');
}

const email = process.argv[2];
const platformEmail = process.argv[3];

if (!email || !platformEmail) {
  console.error('Usage: pnpm run db:setup-email-user <email> <platformEmail>');
  console.error('       npx tsx setupTestEmailUser.ts <email> <platformEmail>');
  console.error('\nExample:');
  console.error('  pnpm run db:setup-email-user alice@example.com alice.anderson@app.example.com');
  console.error('  npx tsx setupTestEmailUser.ts alice@example.com alice.anderson@app.example.com');
  process.exit(1);
}

setupTestEmailUser(email, platformEmail).catch(err => {
  console.error('\n❌ Error:', err.message);
  if (err.stack) {
    console.error('\nStack trace:');
    console.error(err.stack);
  }
  process.exit(1);
});
