#!/usr/bin/env tsx
/**
 * Quick script to create a test email for the Bob Baker test user
 */

import { connectDB, IngestedEmailModel, User } from '@bike4mind/database';
import { Config } from './utils/config';
import mongoose from 'mongoose';

async function createTestEmail() {
  const mongoUri = Config.MONGODB_URI;
  if (!mongoUri) {
    console.error('MONGODB_URI not configured');
    process.exit(1);
  }

  console.log('Connecting to MongoDB...');
  await connectDB(mongoUri);
  console.log('Connected!\n');

  // Find user with platform email
  const user = await User.findOne({
    platformEmailAddress: 'bob.baker@app.example.com',
  });

  if (!user) {
    console.error('User not found with platform email: bob.baker@app.example.com');
    console.log('\nTrying to find user by email bob@example.com...');

    const userByEmail = await User.findOne({ email: 'bob@example.com' });
    if (!userByEmail) {
      console.error('User not found!');
      process.exit(1);
    }

    console.log('Found user, updating with platform email...');
    userByEmail.platformEmailAddress = 'bob.baker@app.example.com';
    if (!userByEmail.authorizedEmailAddresses) {
      userByEmail.authorizedEmailAddresses = [];
    }
    if (!userByEmail.authorizedEmailAddresses.includes('bob@example.com')) {
      userByEmail.authorizedEmailAddresses.push('bob@example.com');
    }
    await userByEmail.save();
    console.log('✅ User updated!');
  }

  const targetUser = user || (await User.findOne({ email: 'bob@example.com' }));

  if (!targetUser) {
    console.error('Still no user found!');
    process.exit(1);
  }

  console.log(`Creating test email for user: ${targetUser.username} (${targetUser.email})`);
  console.log(`Platform email: ${targetUser.platformEmailAddress}\n`);

  // Create test email
  const now = new Date();
  const email = await IngestedEmailModel.create({
    messageId: `<test-${Date.now()}@test.bike4mind.com>`,
    threadId: `<test-${Date.now()}@test.bike4mind.com>`,
    from: 'bob@example.com',
    to: ['bob.baker@app.example.com'],
    subject: 'Test Email from Email Ingestion Script',
    bodyText: `This is a test email created at ${now.toLocaleString()}.

This email was created by the email ingestion test script to verify that emails appear in your Email Inbox.

Key features tested:
- Email parsing ✓
- Sender validation ✓
- MongoDB storage ✓
- UI display (check your inbox!)

You should see this email in your Email Inbox tab.`,
    bodyHtml: `<html>
<body>
  <h1>Test Email from Email Ingestion Script</h1>
  <p>This is a test email created at <strong>${now.toLocaleString()}</strong>.</p>

  <p>This email was created by the email ingestion test script to verify that emails appear in your <strong>Email Inbox</strong>.</p>

  <h2>Key features tested:</h2>
  <ul>
    <li>✓ Email parsing</li>
    <li>✓ Sender validation</li>
    <li>✓ MongoDB storage</li>
    <li>✓ UI display (check your inbox!)</li>
  </ul>

  <p>You should see this email in your <strong>Email Inbox</strong> tab.</p>
</body>
</html>`,
    bodyMarkdown: `# Test Email from Email Ingestion Script

This is a test email created at **${now.toLocaleString()}**.

This email was created by the email ingestion test script to verify that emails appear in your **Email Inbox**.

## Key features tested:
- ✓ Email parsing
- ✓ Sender validation
- ✓ MongoDB storage
- ✓ UI display (check your inbox!)

You should see this email in your **Email Inbox** tab.`,
    userId: targetUser._id.toString(),
    receivedAt: now,
    ingestedAt: now,
    attachments: [],
    scrapedLinks: [],
  });

  console.log('✅ Test email created successfully!');
  console.log(`   Email ID: ${email._id}`);
  console.log(`   Subject: ${email.subject}`);
  console.log(`   From: ${email.from}`);
  console.log(`   To: ${email.to.join(', ')}`);
  console.log(`\n📧 Check your Email Inbox tab to see the email!`);

  await mongoose.disconnect();
}

createTestEmail().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
