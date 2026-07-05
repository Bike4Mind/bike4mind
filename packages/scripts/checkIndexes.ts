#!/usr/bin/env npx tsx

import { connectDB } from '@bike4mind/database';
import { Resource } from 'sst';
import mongoose from 'mongoose';

async function checkIndexes() {
  const dbUri = Resource.MONGODB_URI.value;

  console.log('🔌 Connecting to staging database...');
  await connectDB(dbUri);
  console.log('✅ Connected successfully\n');

  const db = mongoose.connection.db;
  if (!db) {
    throw new Error('Database connection not established');
  }
  const collection = db.collection('users');

  console.log('📊 Checking indexes on User collection:');
  console.log('=====================================\n');

  const indexes = await collection.indexes();

  // Filter for email verification related indexes
  const emailVerificationIndexes = indexes.filter(
    index => index.name?.includes('email') || index.name?.includes('pending')
  );

  console.log('Email Verification Indexes:');
  emailVerificationIndexes.forEach(index => {
    console.log(`  ✓ ${index.name}`);
    console.log(`    Keys: ${JSON.stringify(index.key)}`);
    if (index.sparse) console.log(`    Sparse: true`);
    if (index.background) console.log(`    Background: true`);
    console.log('');
  });

  console.log(`Total indexes on users collection: ${indexes.length}`);
  console.log(`Email verification indexes found: ${emailVerificationIndexes.length}`);

  process.exit(0);
}

checkIndexes().catch(e => {
  console.error('❌ Error:', e);
  process.exit(1);
});
