// GET /api/organizations/:id/feedback-report/items
// The rows behind a report cell: metadata only, same owner/manager gate as the counts.

import {
  FEEDBACK_LIST_DEFAULT_LIMIT,
  FEEDBACK_LIST_MAX_LIMIT,
  FEEDBACK_SUBJECTS,
  OrgFeedbackItemPage,
} from '@bike4mind/common';
import { orgFeedbackItems } from '@bike4mind/database';
import { organizationRepository } from '@bike4mind/database/infra';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { clampedIntParam } from '@server/utils/dateParam';
import { ForbiddenError } from '@server/utils/errors';
import { verifyOrgAccess } from '@server/utils/orgAccess';
import { resolveReportWindow } from '@server/utils/orgFeedbackWindow';
import { Request, Response } from 'express';
import { z } from 'zod';

// Matches the counts route: an owner can re-run this with one date-picker drag.
const ITEMS_RATE_LIMIT = { limit: 10, windowMs: 60 * 1000 } as const;

// Deep paging past this is a sign the caller wants the window narrowed, not the offset raised,
// and an unbounded `skip` is a full-collection walk per request.
const MAX_OFFSET = 10_000;

const subjectSchema = z.enum(FEEDBACK_SUBJECTS).optional();

interface ItemsQuery {
  id?: string;
  from?: string;
  to?: string;
  subject?: string;
  limit?: string;
  offset?: string;
}

const handler = baseApi()
  .use(rateLimit(ITEMS_RATE_LIMIT))
  .get(async (req: Request<{}, OrgFeedbackItemPage, unknown, ItemsQuery>, res: Response) => {
    if (!req.user) throw new ForbiddenError('Authentication required');

    const { from, to } = resolveReportWindow(req.query);
    const subject = subjectSchema.parse(req.query.subject);
    const limit = clampedIntParam('limit', req.query.limit, FEEDBACK_LIST_DEFAULT_LIMIT, 1, FEEDBACK_LIST_MAX_LIMIT);
    const offset = clampedIntParam('offset', req.query.offset, 0, 0, MAX_OFFSET);

    // Owner/manager (or platform admin), answering NotFoundError for a missing org and one the
    // caller may not administer alike - do not "improve" the non-member branch into a
    // ForbiddenError, or the route becomes an org-id oracle.
    const organizationId = String(req.query.id ?? '');
    await verifyOrgAccess(req.user, organizationId);

    // Re-read rather than trusting anything the client sent: the author of every row returned must
    // still be in the org's member union, which is also what the counts were scoped on.
    const members = await organizationRepository.findMemberUserIds(organizationId);
    const page = await orgFeedbackItems({ organizationId, from, to, members, subject, limit, offset });

    return res.status(200).json(page);
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
