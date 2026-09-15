#!/usr/bin/env tsx
/**
 * Set up test user for email ingestion testing
 *
 * Usage:
 *   npx tsx server/scripts/setupTestEmailUser.ts <email> <platformEmail>
 *
 * Example:
 *   npx tsx server/scripts/setupTestEmailUser.ts alice@example.com alice.anderson@app.example.com
 */

import { User } from '@bike4mind/database';
import mongoose from 'mongoose';
import { Resource } from 'sst';

async function setupTestEmailUser(email: string, platformEmail: string) {
  const mongoUri = Resource.MONGODB_URI.value;

  console.log('Connecting to MongoDB...');
  await mongoose.connect(mongoUri);
  console.log('Connected to MongoDB');

  const user = await User.findOne({ email });

  if (!user) {
    console.error(`❌ User with email ${email} not found`);
    process.exit(1);
  }

  console.log(`✅ Found user: ${user.username} (${user.email})`);
  console.log(`   User ID: ${user._id}`);

  user.platformEmailAddress = platformEmail;
  user.authorizedEmailAddresses = [email];

  await user.save();

  console.log('\n✅ User updated successfully!');
  console.log(`   Platform Email: ${user.platformEmailAddress}`);
  console.log(`   Authorized Senders: ${user.authorizedEmailAddresses.join(', ')}`);
  console.log('\n📧 Ready to test! Send an email:');
  console.log(`   From: ${email}`);
  console.log(`   To: ${platformEmail}`);
  console.log(`   Subject: Test Email Ingestion`);

  await mongoose.disconnect();
}

const email = process.argv[2];
const platformEmail = process.argv[3];

if (!email || !platformEmail) {
  console.error('Usage: npx tsx server/scripts/setupTestEmailUser.ts <email> <platformEmail>');
  console.error(
    'Example: npx tsx server/scripts/setupTestEmailUser.ts alice@example.com alice.anderson@app.example.com'
  );
  process.exit(1);
}

setupTestEmailUser(email, platformEmail).catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
