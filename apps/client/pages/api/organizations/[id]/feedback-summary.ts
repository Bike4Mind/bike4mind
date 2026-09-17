// GET/POST /api/organizations/:id/feedback-summary
// POST enqueues an LLM summary of the org's feedback over a window; GET returns whatever exists
// for that window, artifact and all. Same owner/manager gate as the counts route on both, and the
// worker that consumes the message reports back over the websocket.

import type { OrgFeedbackSummaryArtifact, OrgFeedbackSummaryView } from '@bike4mind/common';
import {
  OrgFeedbackSummaryJob,
  ORG_FEEDBACK_SUMMARY_ACTIVE_KEY,
  ORG_FEEDBACK_SUMMARY_ACTIVE_STATUSES,
} from '@bike4mind/database';
import { S3Storage } from '@bike4mind/fab-pipeline';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { getSourceQueueUrl } from '@server/utils/dlqRegistry';
import { BadRequestError, ForbiddenError } from '@server/utils/errors';
import { verifyOrgAccess } from '@server/utils/orgAccess';
import { sendToQueue } from '@server/utils/sqs';
import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { Resource } from 'sst';
import { z } from 'zod';

// An LLM pass per request, so this is capped far below the read routes' 10/min.
const SUMMARY_RATE_LIMIT = { limit: 3, windowMs: 60 * 1000, bucket: 'organizations/feedback-summary' } as const;

// A year of feedback is already more than one prompt can carry, and the window is what bounds the
// aggregate the worker runs.
const MAX_WINDOW_DAYS = 365;
const MAX_WINDOW_MS = MAX_WINDOW_DAYS * 24 * 60 * 60 * 1000;

const bodySchema = z
  .object({
    startDate: z.string().min(1).datetime(),
    endDate: z.string().min(1).datetime(),
  })
  .refine(v => new Date(v.startDate) < new Date(v.endDate), {
    message: 'startDate must be before endDate',
  })
  .refine(v => new Date(v.endDate).getTime() - new Date(v.startDate).getTime() <= MAX_WINDOW_MS, {
    message: `Range must not exceed ${MAX_WINDOW_DAYS} days`,
  });

/** Mongo's duplicate-key error, which here means a job already owns this window. */
const isDuplicateKey = (error: unknown) => (error as { code?: number })?.code === 11000;

const windowSchema = z.object({
  startDate: z.string().min(1).datetime(),
  endDate: z.string().min(1).datetime(),
});

// Per-method, not `.use()`: the read is cheap and the panel re-reads it whenever the worker says
// it finished, so it must not spend the enqueue budget.
const READ_RATE_LIMIT = { limit: 30, windowMs: 60 * 1000, bucket: 'organizations/feedback-summary-read' } as const;

const handler = baseApi()
  .get(
    rateLimit(READ_RATE_LIMIT),
    async (
      req: Request<{ id?: string }, unknown, unknown, { id?: string; startDate?: string; endDate?: string }>,
      res: Response
    ) => {
      if (!req.user) throw new ForbiddenError('Authentication required');

      const organizationId = String(req.query.id ?? '');
      await verifyOrgAccess(req.user, organizationId);

      const { startDate, endDate } = windowSchema.parse({
        startDate: req.query.startDate,
        endDate: req.query.endDate,
      });

      // Newest first: a window can have been summarized, released and asked for again, and the
      // panel wants the run it is watching, not the one that finished last month.
      const job = await OrgFeedbackSummaryJob.findOne({
        organizationId,
        startDate: new Date(startDate),
        endDate: new Date(endDate),
      })
        .sort({ createdAt: -1 })
        .lean();

      if (!job) return res.status(200).json({ status: 'none' } satisfies OrgFeedbackSummaryView);

      if (job.status !== 'completed' || !job.s3Key) {
        return res.status(200).json({
          status: job.status,
          summaryJobId: job.summaryJobId,
          ...(job.errorMessage ? { errorMessage: job.errorMessage } : {}),
        } satisfies OrgFeedbackSummaryView);
      }

      const raw = await new S3Storage(Resource.appFilesBucket.name).getContentAsString(job.s3Key);
      return res.status(200).json({
        status: 'completed',
        summaryJobId: job.summaryJobId,
        artifact: JSON.parse(raw) as OrgFeedbackSummaryArtifact,
      } satisfies OrgFeedbackSummaryView);
    }
  )
  .post(
    rateLimit(SUMMARY_RATE_LIMIT),
    async (req: Request<{ id?: string }, unknown, unknown, { id?: string }>, res: Response) => {
      if (!req.user) throw new ForbiddenError('Authentication required');

      // Owner/manager (or platform admin), matching the counts route exactly: the summary is built
      // from the same rows. NotFoundError covers both a missing org and one the caller may not
      // administer - do not split that branch, or this becomes an org-id oracle.
      const organizationId = String(req.query.id ?? '');
      await verifyOrgAccess(req.user, organizationId);

      const body = req.body;
      if (!body || typeof body !== 'object') throw new BadRequestError('Missing request body');
      const { startDate, endDate } = bodySchema.parse(body);

      const summaryJobId = uuidv4();
      const window = { startDate: new Date(startDate), endDate: new Date(endDate) };

      try {
        await OrgFeedbackSummaryJob.create({
          summaryJobId,
          organizationId,
          requestedBy: req.user.id,
          ...window,
          status: 'pending',
          activeKey: ORG_FEEDBACK_SUMMARY_ACTIVE_KEY,
        });
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;

        // Someone already asked for this window and it is still running - hand back their job rather
        // than paying for the LLM pass twice. A completed or failed job releases its activeKey, so
        // this only ever joins work actually in flight.
        const existing = await OrgFeedbackSummaryJob.findOne({
          organizationId,
          ...window,
          status: { $in: ORG_FEEDBACK_SUMMARY_ACTIVE_STATUSES },
        }).lean();
        // The row can vanish between the write and this read (the job finished, and with it its hold
        // on the window); a retry is honest here because nothing was enqueued.
        if (!existing) throw error;
        return res.status(200).json({ summaryJobId: existing.summaryJobId, reused: true });
      }

      try {
        // Rides the quest-export queue rather than a new one: a queue is 1:1 with a lambda in the
        // infra stack, and the consumer discriminates on jobType.
        await sendToQueue(getSourceQueueUrl('questExportQueue'), {
          jobType: 'orgFeedbackSummary',
          summaryJobId,
          organizationId,
          startDate,
          endDate,
          userId: req.user.id,
        });
      } catch (error) {
        // Release the window: leaving a pending row behind would lock every later request out of it
        // until the TTL expired, with no worker ever coming to clear it.
        await OrgFeedbackSummaryJob.updateOne(
          { summaryJobId },
          { status: 'failed', activeKey: summaryJobId, errorMessage: 'Failed to enqueue summary job' }
        );
        throw error;
      }

      return res.status(202).json({ summaryJobId, reused: false });
    }
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
