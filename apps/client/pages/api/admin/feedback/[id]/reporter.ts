import { ApiKeyScope, MODERATION_PAGE_READ, NotFoundError, type FeedbackReporterSummary } from '@bike4mind/common';
import { FeedbackModel, userRepository } from '@bike4mind/database';
import { SUBSCRIPTION_PLANS_MAP } from '@bike4mind/server-utils/lib/userSubscriptions/constants';
import { subscriptionRepository } from '@bike4mind/server-utils/models/Subscription';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';
import { adminApi } from '@server/middlewares/adminApi';

/** Reporter facts for the feedback drawer, gated like the Users page read. Carries no name or email. */
const handler = adminApi({ requiredScopes: [ApiKeyScope.ADMIN], adminPermissions: { GET: MODERATION_PAGE_READ } }).get(
  async (req, res) => {
    const id = String(req.query.id ?? '');
    if (!isValidObjectId(id)) throw new NotFoundError('Feedback not found');
    const feedback = await FeedbackModel.findById(id).select('userId createdAt').lean();
    if (!feedback) throw new NotFoundError('Feedback not found');

    const { userId } = feedback;
    if (!isValidObjectId(userId)) {
      const response: FeedbackReporterSummary = { reporter: null };
      return res.json(response);
    }

    const [user, subscriptions, earlierReports] = await Promise.all([
      userRepository.findById(userId),
      subscriptionRepository.findActiveUserSubscriptions(userId),
      FeedbackModel.countDocuments({ userId, createdAt: { $lt: feedback.createdAt } }),
    ]);
    const plan = subscriptions.map(sub => SUBSCRIPTION_PLANS_MAP[sub.priceId]?.name).find(name => !!name) ?? null;

    const response: FeedbackReporterSummary = {
      reporter: {
        userId,
        exists: !!user,
        plan: user ? plan : null,
        createdAt: user?.createdAt ? new Date(user.createdAt).toISOString() : null,
        isBanned: !!user?.isBanned,
        earlierReports,
      },
    };
    return res.json(response);
  }
);

export default handler;
