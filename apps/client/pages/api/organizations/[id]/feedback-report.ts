// GET /api/organizations/:id/feedback-report
// Counts of org-stamped feedback over a date window, for the org's owner/manager.

import { FEEDBACK_SUBJECTS, OrgFeedbackReport } from '@bike4mind/common';
import { orgFeedbackReport } from '@bike4mind/database';
import { organizationRepository } from '@bike4mind/database/infra';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { ForbiddenError } from '@server/utils/errors';
import { verifyOrgAccess } from '@server/utils/orgAccess';
import { resolveReportWindow } from '@server/utils/orgFeedbackWindow';
import { Request, Response } from 'express';
import { z } from 'zod';

// Session-only, like every sibling under organizations/[id]/ - no api-contract, no API key.
// A $facet over the feedback collection is the most expensive read in this area and an owner can
// re-run it with one date-picker drag, so it is capped where the sibling reads are not.
const REPORT_RATE_LIMIT = { limit: 10, windowMs: 60 * 1000, bucket: 'organizations/feedback-report' } as const;

const subjectSchema = z.enum(FEEDBACK_SUBJECTS).optional();

interface ReportQuery {
  id?: string;
  from?: string;
  to?: string;
  subject?: string;
}

const handler = baseApi()
  .use(rateLimit(REPORT_RATE_LIMIT))
  .get(async (req: Request<{}, OrgFeedbackReport, unknown, ReportQuery>, res: Response) => {
    if (!req.user) throw new ForbiddenError('Authentication required');

    // Shared with the drill-down list, so the counts and the rows behind them cover the same days.
    const { from: fromDate, to: toDate } = resolveReportWindow(req.query);
    const subject = subjectSchema.parse(req.query.subject);

    // Owner/manager (or platform admin), not plain membership: the report names individual members
    // and their submission counts. Answers NotFoundError identically for a missing org and one the
    // caller may not administer, so this route cannot be used to enumerate org ids - do not
    // "improve" the non-member branch into a ForbiddenError.
    const organizationId = String(req.query.id ?? '');
    await verifyOrgAccess(req.user, organizationId);

    const members = await organizationRepository.findMemberUserIds(organizationId);
    const report = await orgFeedbackReport({
      organizationId,
      from: fromDate,
      to: toDate,
      members,
      subject,
    });

    return res.status(200).json(report);
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
