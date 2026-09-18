// GET /api/organizations/:id/feedback-report/:feedbackId
// One row behind a report cell. Carries no feedback text: verbatim stays on the CASL-gated
// /api/feedback/:id/read, which grants it to the reporter or a platform admin only.

import { OrgFeedbackItem } from '@bike4mind/common';
import { orgFeedbackItem } from '@bike4mind/database';
import { organizationRepository } from '@bike4mind/database/infra';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { ForbiddenError, NotFoundError } from '@server/utils/errors';
import { isValidObjectId } from '@server/utils/objectId';
import { verifyOrgAccess } from '@server/utils/orgAccess';
import { Request, Response } from 'express';

// Bucketed explicitly: the pathname embeds the feedback id, so the default would give every row
// its own counter and leave enumeration effectively uncapped.
const DRILLDOWN_RATE_LIMIT = { limit: 60, windowMs: 60 * 1000, bucket: 'organizations/feedback-report-item' } as const;

// One message for every denial - unknown id, malformed id, foreign org stamp, author no longer in
// the org. A caller who may administer the org still must not learn which feedback ids exist
// outside it, so none of these branches may be split into a distinguishable status.
const DENIED = 'Feedback not found';

interface ItemQuery {
  id?: string;
  feedbackId?: string;
}

const handler = baseApi()
  .use(rateLimit(DRILLDOWN_RATE_LIMIT))
  .get(async (req: Request<{}, OrgFeedbackItem, unknown, ItemQuery>, res: Response) => {
    if (!req.user) throw new ForbiddenError('Authentication required');

    // Authorize the org first; only then say anything at all about a feedback id.
    const organizationId = String(req.query.id ?? '');
    await verifyOrgAccess(req.user, organizationId);

    const feedbackId = String(req.query.feedbackId ?? '');
    // A non-ObjectId id can never name a row, and casting it would throw out of the driver.
    if (!isValidObjectId(feedbackId)) throw new NotFoundError(DENIED);

    const members = await organizationRepository.findMemberUserIds(organizationId);
    const item = await orgFeedbackItem({ organizationId, feedbackId, members });
    if (!item) throw new NotFoundError(DENIED);

    return res.status(200).json(item);
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
