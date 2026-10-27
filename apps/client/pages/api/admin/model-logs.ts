import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { Quest } from '@bike4mind/database';
import { escapeRegex } from '@bike4mind/utils/escapeRegex';
import { ApiKeyScope } from '@bike4mind/common';
import type { PipelineStage, Types } from 'mongoose';
import { z } from 'zod';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { dateParam } from '@server/utils/dateParam';
import { MODEL_LOGS_MAX_PAGE } from '@client/shared/modelLogs';

export const MODEL_LOGS_MAX_LIMIT = 100;
const MODEL_LOGS_DEFAULT_LIMIT = 25;
const ARTIFACT_PREVIEW_CHARS = 100;

const querySchema = z.object({
  startDate: dateParam.optional(),
  endDate: dateParam.optional(),
  model: z.string().optional(),
  search: z.string().optional(),
  page: z.coerce.number().int().min(1).max(MODEL_LOGS_MAX_PAGE).default(1),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .default(MODEL_LOGS_DEFAULT_LIMIT)
    .transform(limit => Math.min(limit, MODEL_LOGS_MAX_LIMIT)),
});

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

// The tab sends a bare YYYY-MM-DD end date meaning "through that day"; `$lte` its midnight
// dropped every log from the end date itself.
const endDateBound = (endDate: string) =>
  DATE_ONLY.test(endDate) ? { $lt: new Date(Date.parse(endDate) + DAY_MS) } : { $lte: new Date(endDate) };

const arrayLength = (path: string) => ({ $cond: [{ $isArray: path }, { $size: path }, 0] });

// Only what a list card renders. The full promptMeta (tool output, citations, artifacts) made a
// wide date range overflow the Lambda response limit; it is served per log by model-logs/[id].
const LIST_PROJECTION = {
  timestamp: 1,
  modelName: '$promptMeta.model.name',
  totalResponseTime: '$promptMeta.performance.totalResponseTime',
  inputTokens: '$promptMeta.tokenUsage.inputTokens',
  outputTokens: '$promptMeta.tokenUsage.outputTokens',
  attachedFileCount: arrayLength('$promptMeta.context.attachedFiles'),
  messageHistoryLength: '$promptMeta.context.messageHistoryLength',
  completedStepCount: arrayLength('$promptMeta.executionTracking.completedSteps'),
  failedStepCount: arrayLength('$promptMeta.executionTracking.failedSteps'),
  artifacts: {
    $map: {
      input: { $cond: [{ $isArray: '$promptMeta.artifacts' }, '$promptMeta.artifacts', []] },
      in: {
        type: '$$this.type',
        preview: { $substrCP: [{ $ifNull: ['$$this.content', ''] }, 0, ARTIFACT_PREVIEW_CHARS] },
      },
    },
  },
};

type ModelLogSummaryRow = {
  _id: Types.ObjectId;
  timestamp: Date;
  modelName?: string;
  totalResponseTime?: number;
  inputTokens?: number;
  outputTokens?: number;
  attachedFileCount: number;
  messageHistoryLength?: number;
  completedStepCount: number;
  failedStepCount: number;
  artifacts: { type: string; preview: string }[];
};

const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] }).get(
  asyncHandler(async (req, res) => {
    // Check if user is admin
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    try {
      const { startDate, endDate, model, search, page, limit } = querySchema.parse(req.query);

      // aggregate/countDocuments skip the softDeletePlugin's find hook, so filter tombstones here.
      const query: Record<string, unknown> = { deletedAt: null };

      if (startDate || endDate) {
        query.timestamp = {
          ...(startDate ? { $gte: new Date(startDate) } : {}),
          ...(endDate ? endDateBound(endDate) : {}),
        };
      }

      // Add model filter
      if (model) {
        query['promptMeta.model.name'] = model;
      }

      // Add search filter. promptMeta.context.systemPrompt/userPrompt are deliberately never
      // persisted (see ChatCompletionProcess.ts's leak-avoidance comments), so those two arms
      // can never match - dropped rather than fixed. promptMeta.prompt IS persisted
      // (ChatCompletionProcess.ts) and covers the same "search the user's prompt text" intent
      // without that leak risk, so it replaces the dropped userPrompt arm rather than just
      // deleting the capability. executionTracking.steps is an array of objects, so a bare
      // $regex against the array never matches - $elemMatch is the correct way to regex a field
      // inside each element (same pattern already used in fabFileSearchQuery.ts's tag search).
      // Only `name` is included there: `result`/`error` are declared on the step schema but
      // nothing in ChatCompletionProcess.ts ever writes them, so a $regex arm against either
      // would be dead weight, same class of issue as the two dropped context arms.
      if (search) {
        const escapedSearch = escapeRegex(search);
        query.$or = [
          { 'promptMeta.model.name': { $regex: escapedSearch, $options: 'i' } },
          { 'promptMeta.prompt': { $regex: escapedSearch, $options: 'i' } },
          {
            'promptMeta.executionTracking.steps': {
              $elemMatch: { name: { $regex: escapedSearch, $options: 'i' } },
            },
          },
        ];
      }

      const pipeline: PipelineStage[] = [
        { $match: query },
        { $sort: { timestamp: -1, _id: -1 } },
        { $skip: (page - 1) * limit },
        { $limit: limit },
        { $project: LIST_PROJECTION },
      ];
      const [rows, total] = await Promise.all([
        Quest.aggregate<ModelLogSummaryRow>(pipeline),
        Quest.countDocuments(query),
      ]);

      res.json({
        logs: rows.map(({ _id, ...row }) => ({ id: _id.toString(), ...row, timestamp: row.timestamp.toISOString() })),
        total,
        page,
        limit,
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
