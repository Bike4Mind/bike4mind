#!/usr/bin/env tsx

/**
 * Test script for Phase 1: API Usage Monitoring
 *
 * This script helps test the API key usage logging functionality.
 *
 * Usage:
 * 1. Make sure you have a valid API key (create one via /api/user-api-keys POST)
 * 2. Run from root: pnpm --filter @bike4mind/scripts test:api-usage <api-key> <userId>
 *    Or: npx tsx packages/scripts/test-api-usage-monitoring.ts <api-key> <userId>
 *    Or: cd packages/scripts && pnpm tsx test-api-usage-monitoring.ts <api-key> <userId>
 */

import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import { apiKeyUsageLogRepository } from '@bike4mind/database/auth';
import { userApiKeyRepository } from '@bike4mind/database/auth';

dotenv.config();

async function testApiUsageLogging() {
  const apiKey = process.argv[2];
  const userId = process.argv[3];
  const stage = process.argv[4] || process.env.STAGE || 'dev';

  if (!apiKey || !userId) {
    console.log('Usage: pnpm tsx packages/scripts/test-api-usage-monitoring.ts <api-key> <userId> [stage]');
    console.log('\nExample:');
    console.log('  pnpm tsx packages/scripts/test-api-usage-monitoring.ts b4m_live_abc123 user123 dev');
    console.log('\nOr set MONGODB_URI environment variable:');
    console.log(
      '  MONGODB_URI="mongodb://..." pnpm tsx packages/scripts/test-api-usage-monitoring.ts b4m_live_abc123 user123'
    );
    console.log('\nOr run with SST:');
    console.log('  sst dev -- pnpm --filter @bike4mind/scripts test:api-usage b4m_live_abc123 user123');
    process.exit(1);
  }

  try {
    // Get MongoDB URI - try multiple sources
    let mongoUri = process.env.MONGODB_URI;

    // Try to get from SST Resource if available (when run with SST)
    if (!mongoUri) {
      try {
        const { Resource } = await import('sst');
        mongoUri = Resource.MONGODB_URI?.value;
        if (mongoUri) {
          console.log('✅ Using MongoDB URI from SST Resource');
        }
      } catch (err) {
        // SST not available, continue with other options
      }
    }

    if (!mongoUri) {
      // Try to construct from common patterns
      const mongoHost = process.env.MONGODB_HOST || 'localhost';
      const mongoPort = process.env.MONGODB_PORT || '27017';
      const mongoDb = process.env.MONGODB_DB || `lumina5-${stage}`;
      mongoUri = `mongodb://${mongoHost}:${mongoPort}/${mongoDb}`;
      console.log(`⚠️  MONGODB_URI not set, using default: ${mongoUri}`);
      console.log('   To use a different URI, set MONGODB_URI environment variable or run with SST');
    } else {
      // Replace %STAGE% placeholder if present
      mongoUri = mongoUri.replace('%STAGE%', stage);
    }

    console.log(`Connecting to MongoDB (stage: ${stage})...`);
    await mongoose.connect(mongoUri);
    console.log('✅ Connected to database');

    // Find the API key
    const keyPrefix = apiKey.substring(0, 12);
    const apiKeyDoc = await userApiKeyRepository.findByKeyPrefix(keyPrefix);

    if (!apiKeyDoc) {
      console.error('❌ API key not found');
      process.exit(1);
    }

    console.log(`✅ Found API key: ${apiKeyDoc.name} (${apiKeyDoc.id})`);

    // Check recent usage logs
    const recentLogs = await apiKeyUsageLogRepository.findByUserIdAndKeyId(userId, apiKeyDoc.id, 10);
    console.log(`\n📊 Recent usage logs (${recentLogs.length} found):`);

    if (recentLogs.length === 0) {
      console.log('  ⚠️  No usage logs found. Make some API requests with this key first.');
    } else {
      recentLogs.forEach((log, index) => {
        console.log(`\n  ${index + 1}. ${log.method} ${log.endpoint}`);
        console.log(`     IP: ${log.ipAddress}`);
        console.log(`     Status: ${log.statusCode}`);
        console.log(`     Response Time: ${log.responseTime}ms`);
        console.log(`     Timestamp: ${log.timestamp.toISOString()}`);
      });
    }

    // Get usage stats for last hour
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const now = new Date();
    const stats = await apiKeyUsageLogRepository.getUsageStats(userId, apiKeyDoc.id, oneHourAgo, now);

    console.log(`\n📈 Usage stats (last hour):`);
    console.log(`   Total Requests: ${stats.totalRequests}`);
    console.log(`   Avg Response Time: ${stats.avgResponseTime.toFixed(2)}ms`);
    console.log(`   Unique IPs: ${stats.uniqueIPs.length} (${stats.uniqueIPs.join(', ')})`);
    console.log(`   Requests/Min: ${stats.requestsPerMinute.toFixed(2)}`);

    // Get current rate
    const currentRate = await apiKeyUsageLogRepository.getRecentRequestsPerMinute(userId, apiKeyDoc.id, 1);
    console.log(`\n⚡ Current rate (last minute): ${currentRate.toFixed(2)} requests/min`);

    await mongoose.disconnect();
    console.log('\n✅ Test completed');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

testApiUsageLogging();
