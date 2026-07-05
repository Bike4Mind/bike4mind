import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  convertLookupForDocumentDB,
  convertPipelineForDocumentDB,
  createCompatibleLookup,
} from '../utils/documentdb-compat';

describe('$lookup DocumentDB Compatibility', () => {
  const originalEnv = process.env.USE_DOCUMENTDB_COMPATIBILITY;

  afterEach(() => {
    process.env.USE_DOCUMENTDB_COMPATIBILITY = originalEnv;
  });

  describe('convertLookupForDocumentDB', () => {
    it('should leave simple localField/foreignField lookups unchanged', () => {
      process.env.USE_DOCUMENTDB_COMPATIBILITY = 'true';

      const simpleLookup = {
        $lookup: {
          from: 'organizations',
          localField: 'organizationId',
          foreignField: '_id',
          as: 'organization',
        },
      };

      const result = convertLookupForDocumentDB(simpleLookup);
      expect(result).toEqual(simpleLookup);
    });

    it('should convert complex $expr conditions with $and to multiple $match stages', () => {
      process.env.USE_DOCUMENTDB_COMPATIBILITY = 'true';

      const complexLookup = {
        $lookup: {
          from: 'counterlogs',
          let: { modelName: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$metadata.modelName', '$$modelName'] },
                    { $gte: ['$datetime', new Date('2024-01-01')] },
                    { $lte: ['$datetime', new Date('2024-01-07')] },
                  ],
                },
              },
            },
            {
              $group: {
                _id: '$metadata.modelName',
                count: { $sum: 1 },
              },
            },
          ],
          as: 'lastWeekData',
        },
      };

      const result = convertLookupForDocumentDB(complexLookup);

      expect(result.$lookup.from).toBe('counterlogs');
      expect(result.$lookup.let).toEqual({ modelName: '$_id' });
      expect(result.$lookup.as).toBe('lastWeekData');

      // Should have multiple $match stages instead of one $expr with $and
      const pipeline = result.$lookup.pipeline;
      expect(pipeline.length).toBeGreaterThan(3); // Multiple $match stages + $group

      // Should preserve the $group stage at the end
      const groupStage = pipeline.find((stage: any) => stage.$group);
      expect(groupStage).toBeDefined();
      expect(groupStage.$group._id).toBe('$metadata.modelName');
    });

    it('should handle $toObjectId expressions in $expr conditions', () => {
      process.env.USE_DOCUMENTDB_COMPATIBILITY = 'true';

      const toObjectIdLookup = {
        $lookup: {
          from: 'users',
          let: { userId: '$userId' },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ['$_id', { $toObjectId: '$$userId' }] },
              },
            },
          ],
          as: 'user',
        },
      };

      const result = convertLookupForDocumentDB(toObjectIdLookup);

      expect(result.$lookup.from).toBe('users');
      expect(result.$lookup.let).toEqual({ userId: '$userId' });
      expect(result.$lookup.as).toBe('user');

      // Should preserve $expr for $toObjectId expressions
      const pipeline = result.$lookup.pipeline;
      expect(pipeline[0].$match.$expr).toBeDefined();
      expect(pipeline[0].$match.$expr.$eq).toEqual(['$_id', { $toObjectId: '$$userId' }]);
    });

    it('should not modify lookups when DocumentDB compatibility is disabled', () => {
      process.env.USE_DOCUMENTDB_COMPATIBILITY = 'false';

      const complexLookup = {
        $lookup: {
          from: 'counterlogs',
          let: { modelName: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$metadata.modelName', '$$modelName'] },
                    { $gte: ['$datetime', new Date('2024-01-01')] },
                  ],
                },
              },
            },
          ],
          as: 'data',
        },
      };

      const result = convertLookupForDocumentDB(complexLookup);
      expect(result).toEqual(complexLookup);
    });
  });

  describe('createCompatibleLookup', () => {
    it('should create MongoDB-style lookup when compatibility is disabled', () => {
      process.env.USE_DOCUMENTDB_COMPATIBILITY = 'false';

      const result = createCompatibleLookup({
        from: 'users',
        let: { userId: '$userId' },
        conditions: [{ $eq: ['$_id', '$$userId'] }, { $gte: ['$createdAt', new Date('2024-01-01')] }],
        as: 'userData',
      });

      expect(result.$lookup.pipeline[0].$match.$expr.$and).toHaveLength(2);
      expect(result.$lookup.pipeline[0].$match.$expr.$and[0]).toEqual({ $eq: ['$_id', '$$userId'] });
      expect(result.$lookup.pipeline[0].$match.$expr.$and[1]).toEqual({ $gte: ['$createdAt', new Date('2024-01-01')] });
    });

    it('should create DocumentDB-compatible lookup with multiple $match stages', () => {
      process.env.USE_DOCUMENTDB_COMPATIBILITY = 'true';

      const result = createCompatibleLookup({
        from: 'users',
        let: { userId: '$userId' },
        conditions: [{ $eq: ['$_id', '$$userId'] }, { $gte: ['$createdAt', new Date('2024-01-01')] }],
        as: 'userData',
      });

      expect(result.$lookup.pipeline).toHaveLength(2);
      expect(result.$lookup.pipeline[0].$match.$expr).toEqual({ $eq: ['$_id', '$$userId'] });
      expect(result.$lookup.pipeline[1].$match).toEqual({ createdAt: { $gte: new Date('2024-01-01') } });
    });

    it('should include additional stages in the pipeline', () => {
      process.env.USE_DOCUMENTDB_COMPATIBILITY = 'true';

      const result = createCompatibleLookup({
        from: 'counterlogs',
        let: { modelName: '$_id' },
        conditions: [{ $eq: ['$metadata.modelName', '$$modelName'] }],
        as: 'data',
        additionalStages: [{ $group: { _id: '$modelName', count: { $sum: 1 } } }, { $sort: { count: -1 } }],
      });

      const pipeline = result.$lookup.pipeline;
      expect(pipeline).toHaveLength(3);
      expect(pipeline[1].$group).toBeDefined();
      expect(pipeline[2].$sort).toBeDefined();
    });
  });

  describe('convertPipelineForDocumentDB', () => {
    it('should convert multiple $lookup stages in a pipeline', () => {
      process.env.USE_DOCUMENTDB_COMPATIBILITY = 'true';

      const pipeline = [
        { $match: { isActive: true } },
        {
          $lookup: {
            from: 'organizations',
            localField: 'organizationId',
            foreignField: '_id',
            as: 'organization',
          },
        },
        {
          $lookup: {
            from: 'counterlogs',
            let: { userId: '$_id' },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [{ $eq: ['$userId', '$$userId'] }, { $gte: ['$datetime', new Date('2024-01-01')] }],
                  },
                },
              },
            ],
            as: 'logs',
          },
        },
        { $sort: { createdAt: -1 } },
      ];

      const result = convertPipelineForDocumentDB(pipeline);

      expect(result[0]).toEqual({ $match: { isActive: true } });
      expect(result[1].$lookup.from).toBe('organizations'); // Simple lookup unchanged
      expect(result[2].$lookup.from).toBe('counterlogs'); // Complex lookup converted
      expect(result[2].$lookup.pipeline.length).toBeGreaterThan(1); // Multiple stages
    });

    it('should warn about $facet stages in pipeline', () => {
      process.env.USE_DOCUMENTDB_COMPATIBILITY = 'true';

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const pipeline = [
        { $match: { isActive: true } },
        {
          $facet: {
            totalCount: [{ $count: 'count' }],
            users: [{ $limit: 10 }],
          },
        },
      ];

      convertPipelineForDocumentDB(pipeline);

      expect(consoleSpy).toHaveBeenCalledWith(
        'Found $facet in pipeline. Consider using executeFacetCompatible instead.'
      );

      consoleSpy.mockRestore();
    });

    it('should not modify pipeline when compatibility is disabled', () => {
      process.env.USE_DOCUMENTDB_COMPATIBILITY = 'false';

      const pipeline = [
        { $match: { isActive: true } },
        {
          $lookup: {
            from: 'counterlogs',
            let: { userId: '$_id' },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [{ $eq: ['$userId', '$$userId'] }, { $gte: ['$datetime', new Date('2024-01-01')] }],
                  },
                },
              },
            ],
            as: 'logs',
          },
        },
      ];

      const result = convertPipelineForDocumentDB(pipeline);
      expect(result).toEqual(pipeline);
    });
  });

  describe('Real-world patterns', () => {
    it('should handle the Counter Logs API pattern', () => {
      process.env.USE_DOCUMENTDB_COMPATIBILITY = 'true';

      const counterLogsLookup = {
        $lookup: {
          from: 'users',
          let: { userId: '$userId' },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ['$_id', { $toObjectId: '$$userId' }] },
              },
            },
          ],
          as: 'user',
        },
      };

      const result = convertLookupForDocumentDB(counterLogsLookup);

      expect(result.$lookup.from).toBe('users');
      expect(result.$lookup.let).toEqual({ userId: '$userId' });
      expect(result.$lookup.as).toBe('user');

      // Should preserve $toObjectId expression
      const matchStage = result.$lookup.pipeline[0];
      expect(matchStage.$match.$expr.$eq).toEqual(['$_id', { $toObjectId: '$$userId' }]);
    });

    it('should handle the CounterLogModel complex analytics pattern', () => {
      process.env.USE_DOCUMENTDB_COMPATIBILITY = 'true';

      const lastWeekStart = new Date('2024-01-01');
      const lastWeekEnd = new Date('2024-01-07');

      const analyticsLookup = {
        $lookup: {
          from: 'counterlogs',
          let: { modelName: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$metadata.modelName', '$$modelName'] },
                    { $gte: ['$datetime', lastWeekStart] },
                    { $lte: ['$datetime', lastWeekEnd] },
                  ],
                },
              },
            },
            {
              $group: {
                _id: '$metadata.modelName',
                count: { $sum: 1 },
              },
            },
          ],
          as: 'lastWeekData',
        },
      };

      const result = convertLookupForDocumentDB(analyticsLookup);

      expect(result.$lookup.from).toBe('counterlogs');
      expect(result.$lookup.let).toEqual({ modelName: '$_id' });
      expect(result.$lookup.as).toBe('lastWeekData');

      const pipeline = result.$lookup.pipeline;

      // Should have multiple $match stages for the $and conditions
      const matchStages = pipeline.filter((stage: any) => stage.$match);
      expect(matchStages.length).toBeGreaterThan(1);

      // Should preserve the $group stage
      const groupStage = pipeline.find((stage: any) => stage.$group);
      expect(groupStage).toBeDefined();
      expect(groupStage.$group._id).toBe('$metadata.modelName');
      expect(groupStage.$group.count).toEqual({ $sum: 1 });
    });
  });
});
