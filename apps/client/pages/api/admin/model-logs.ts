import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { Quest } from '@bike4mind/database';
import { escapeRegex } from '@bike4mind/utils/escapeRegex';
import { IChatHistoryItemDocument } from '@bike4mind/common';
import { z } from 'zod';
import { ForbiddenError } from '@server/utils/errors';

// Query parameter schema
const querySchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  model: z.string().optional(),
  search: z.string().optional(),
});

const handler = baseApi().get(
  asyncHandler(async (req, res) => {
    // Check if user is admin
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    try {
      console.log('Model logs route hit');

      // Validate query parameters
      const { startDate, endDate, model, search } = querySchema.parse(req.query);
      console.log('Query parameters:', { startDate, endDate, model, search });

      // Build query
      const query: any = {};

      // Add date range filter
      if (startDate || endDate) {
        query.timestamp = {};
        if (startDate) query.timestamp.$gte = new Date(startDate);
        if (endDate) query.timestamp.$lte = new Date(endDate);
      }

      // Add model filter
      if (model) {
        query['promptMeta.model.name'] = model;
      }

      // Add search filter
      if (search) {
        const escapedSearch = escapeRegex(search);
        query.$or = [
          { 'promptMeta.model.name': { $regex: escapedSearch, $options: 'i' } },
          { 'promptMeta.context.systemPrompt': { $regex: escapedSearch, $options: 'i' } },
          { 'promptMeta.context.userPrompt': { $regex: escapedSearch, $options: 'i' } },
          { 'promptMeta.executionTracking.steps': { $regex: escapedSearch, $options: 'i' } },
        ];
      }

      console.log('MongoDB query:', JSON.stringify(query, null, 2));

      // Fetch logs from database
      const logs = await Quest.find(query).select('promptMeta timestamp').sort({ timestamp: -1 }).limit(1000);

      console.log('Found logs:', logs.length);

      // Transform logs to match the expected format
      const transformedLogs = logs.map((log: IChatHistoryItemDocument) => ({
        id: log.id,
        timestamp: log.timestamp.toISOString(),
        ...log.promptMeta,
      }));

      console.log('Transformed logs:', transformedLogs.length);

      res.json({
        logs: transformedLogs,
        total: transformedLogs.length,
      });
    } catch (error) {
      console.error('Error fetching model logs:', error);
      throw error; // Let the error handler middleware handle it
    }
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
