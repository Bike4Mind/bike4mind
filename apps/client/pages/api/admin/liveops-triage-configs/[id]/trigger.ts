/**
 * LiveOps Triage Config - Manual Trigger API
 *
 * POST - Manually trigger a triage run for a specific config
 *
 * Supports dry run mode via `{ dryRun: true }` in request body.
 * Enqueues job to SQS with debounce protection (5 min minimum between runs).
 */

import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import {
  liveopsTriageConfigRepository,
  liveopsTriageRunRepository,
  liveopsTriageConfigAuditLogRepository,
} from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, NotFoundError, ForbiddenError } from '@server/utils/errors';
import { z } from 'zod';
import { Types } from 'mongoose';
import { getSourceQueueUrl } from '@server/utils/dlqRegistry';
import type { LiveOpsTriageJobMessage } from '@server/cron/liveopsTriageDispatcher';

const DEBOUNCE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Schema for trigger request body
 */
const TriggerRequestSchema = z.object({
  dryRun: z.boolean().optional().default(false),
  lookbackHours: z.number().int().min(1).max(168).optional(),
});

/**
 * Validate ObjectId format
 */
function isValidObjectId(id: string): boolean {
  return Types.ObjectId.isValid(id) && new Types.ObjectId(id).toString() === id;
}

const handler = baseApi().post(async (req, res) => {
  try {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const { id } = req.query;

    if (!id || typeof id !== 'string') {
      throw new BadRequestError('Config ID is required');
    }

    if (!isValidObjectId(id)) {
      throw new BadRequestError('Invalid config ID format');
    }

    // Validate request body
    const parseResult = TriggerRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      const errors = parseResult.error.flatten();
      return res.status(400).json({
        error: 'Validation failed',
        code: 'VALIDATION_FAILED',
        validationErrors: errors.fieldErrors,
      });
    }

    const { dryRun, lookbackHours } = parseResult.data;

    // Fetch config
    const config = await liveopsTriageConfigRepository.findById(id);
    if (!config) {
      throw new NotFoundError('Config not found');
    }

    // Debounce check - prevent overlapping runs
    if (config.lastRunStartedAt) {
      const lastRunTime = config.lastRunStartedAt.getTime();
      if (Date.now() - lastRunTime < DEBOUNCE_WINDOW_MS) {
        return res.status(429).json({
          error: 'A run was started recently. Please wait before triggering again.',
          code: 'DEBOUNCE_ACTIVE',
          lastRunStartedAt: config.lastRunStartedAt.toISOString(),
          retryAfter: Math.ceil((DEBOUNCE_WINDOW_MS - (Date.now() - lastRunTime)) / 1000),
        });
      }
    }

    // Check for active runs
    const hasActiveRun = await liveopsTriageRunRepository.hasActiveRunForConfig(id);
    if (hasActiveRun) {
      return res.status(409).json({
        error: 'An active run already exists for this config',
        code: 'ACTIVE_RUN_EXISTS',
      });
    }

    // Create message payload
    const message: LiveOpsTriageJobMessage = {
      configId: config.id,
      configName: config.name,
      dispatchedAt: Date.now(),
      source: 'manual',
      dryRun,
      lookbackHours,
    };

    // Send to SQS
    const sqsClient = new SQSClient({});
    const queueUrl = getSourceQueueUrl('liveOpsTriageQueue');

    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(message),
      })
    );

    console.log('[LIVEOPS-CONFIG-API] Manual run triggered', {
      configId: id,
      configName: config.name,
      dryRun,
      triggeredBy: req.user.id,
    });

    // Audit log for SOC2 compliance - track manual triggers
    await liveopsTriageConfigAuditLogRepository.createLog({
      configId: id,
      configName: config.name,
      action: 'trigger',
      userId: req.user.id,
      userName: req.user.username ?? req.user.email ?? 'Unknown',
      changes: {
        dryRun: { old: null, new: dryRun },
        source: { old: null, new: 'manual' },
      },
    });

    return res.status(202).json({
      success: true,
      message: `Triage ${dryRun ? 'dry run' : 'run'} queued for ${config.name}`,
      configId: id,
      configName: config.name,
      dryRun,
    });
  } catch (error) {
    console.error('[LIVEOPS-CONFIG-API] Error triggering run:', error);
    if (error instanceof NotFoundError) {
      return res.status(404).json({ error: error.message });
    }
    if (error instanceof BadRequestError) {
      return res.status(400).json({ error: error.message });
    }
    return res.status(500).json({ error: 'Failed to trigger run' });
  }
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
