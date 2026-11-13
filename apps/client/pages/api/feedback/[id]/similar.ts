import { adminApi } from '@server/middlewares/adminApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { recordFeedbackRead } from '@server/utils/feedbackReadAudit';
import { getSimilarFeedback } from '@server/feedback/similar';

export default adminApi({ auth: 'jwtOnly', adminPermissions: { GET: 'users:moderate' } })
  .use(rateLimit({ limit: 30, windowMs: 60_000, bucket: 'feedback-similar' }))
  .get(async (req, res) => {
    const id = req.query.id;
    if (typeof id !== 'string') throw new BadRequestError('Invalid ID');
    const result = await getSimilarFeedback(id, {
      canRead: report => Boolean(req.ability?.can('read', report)),
      audit: reports => recordFeedbackRead(req, reports, { source: 'similar' }),
    });
    return res.json(result);
  });
