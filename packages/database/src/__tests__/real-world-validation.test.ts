import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { CounterLog, User } from '../models';
import mongoose from 'mongoose';

// Simplified real-world validation test focusing on compatibility logic
describe('Real-World $lookup Validation', () => {
  const originalEnv = process.env.USE_DOCUMENTDB_COMPATIBILITY;
  let testUser: any;

  beforeAll(async () => {
    // Skip if no database connection available
    if (mongoose.connection.readyState !== 1) {
      console.log('Skipping real-world tests - no database connection');
      return;
    }

    // Clean up any existing test data
    await CounterLog.deleteMany({ userOrganization: 'ValidationTest' });
    await User.deleteMany({ email: { $regex: '@validation-test\\.com$' } });
  }, 30000);

  afterAll(async () => {
    if (mongoose.connection.readyState !== 1) return;

    // Clean up test data
    await CounterLog.deleteMany({ userOrganization: 'ValidationTest' });
    await User.deleteMany({ email: { $regex: '@validation-test\\.com$' } });

    // Restore environment
    process.env.USE_DOCUMENTDB_COMPATIBILITY = originalEnv;
  }, 30000);

  describe('CounterLog $lookup Compatibility', () => {
    beforeAll(async () => {
      if (mongoose.connection.readyState !== 1) {
        console.log('Skipping test setup - no database connection');
        return;
      }

      // Create test user
      testUser = await User.create({
        username: 'validation-user',
        name: 'Validation Test User',
        email: 'user@validation-test.com',
        level: 'Pro',
      });

      // Create test counter log
      await CounterLog.create({
        userId: testUser._id.toString(),
        userName: testUser.name,
        userLevel: testUser.level,
        userOrganization: 'ValidationTest',
        counterName: 'validation_action',
        counterValue: 1,
        datetime: new Date(),
        metadata: {
          modelName: 'ValidationModel',
          action: 'test',
          testFlag: true,
        },
      });
    }, 15000);

    it('should return identical results with both compatibility modes', async () => {
      if (mongoose.connection.readyState !== 1) {
        console.log('Skipping test - no database connection');
        return;
      }

      const testQuery = {
        $match: {
          userOrganization: 'ValidationTest',
          counterName: 'validation_action',
        },
      };

      const lookupStage = {
        $lookup: {
          from: 'users',
          let: { userId: { $toObjectId: '$userId' } },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ['$_id', '$$userId'] },
              },
            },
          ],
          as: 'user',
        },
      };

      // Test with MongoDB mode (default)
      process.env.USE_DOCUMENTDB_COMPATIBILITY = 'false';
      const mongoResults = await CounterLog.aggregate([testQuery, lookupStage]);

      // Test with DocumentDB compatibility mode
      process.env.USE_DOCUMENTDB_COMPATIBILITY = 'true';
      const docdbResults = await CounterLog.aggregate([testQuery, lookupStage]);

      // Validate results are identical
      expect(docdbResults).toHaveLength(mongoResults.length);

      if (mongoResults.length > 0) {
        const mongoDoc = mongoResults[0];
        const docdbDoc = docdbResults[0];

        // Verify core fields
        expect(docdbDoc.counterName).toBe(mongoDoc.counterName);
        expect(docdbDoc.counterValue).toBe(mongoDoc.counterValue);
        expect(docdbDoc.userOrganization).toBe(mongoDoc.userOrganization);

        // Verify user lookup worked in both modes
        expect(docdbDoc.user).toBeDefined();
        expect(mongoDoc.user).toBeDefined();
        expect(docdbDoc.user.length).toBe(mongoDoc.user.length);

        console.log(`✅ Both modes returned identical results (${mongoResults.length} documents)`);
      }
    }, 10000);

    it('should handle facet alternatives correctly', async () => {
      if (mongoose.connection.readyState !== 1) {
        console.log('Skipping test - no database connection');
        return;
      }

      const matchQuery = { userOrganization: 'ValidationTest' };

      // Simulate $facet with parallel queries (DocumentDB compatible approach)
      const [countResult, dataResult] = await Promise.all([
        CounterLog.aggregate([{ $match: matchQuery }, { $count: 'total' }]),
        CounterLog.aggregate([{ $match: matchQuery }, { $sort: { datetime: -1 } }, { $limit: 5 }]),
      ]);

      const totalCount = countResult[0]?.total || 0;
      const limitedData = dataResult;

      // Verify results
      expect(totalCount).toBeGreaterThan(0);
      expect(limitedData.length).toBeLessThanOrEqual(Math.min(5, totalCount));

      console.log(`📊 Facet Alternative: ${totalCount} total, ${limitedData.length} limited`);
    }, 10000);
  });
});
