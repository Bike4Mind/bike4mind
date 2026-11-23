import {
  CREDITS_PAGE_READ,
  hasAdminPermission,
  MODERATION_PAGE_READ,
  NotFoundError,
  type FeedbackReporterSummary,
} from '@bike4mind/common';
import { FeedbackModel, organizationRepository, userRepository } from '@bike4mind/database';
import { SubscriptionOwnerType } from '@bike4mind/server-utils/lib/subscriptions/types';
import { SUBSCRIPTION_PLANS_MAP } from '@bike4mind/server-utils/lib/userSubscriptions/constants';
import { subscriptionRepository } from '@bike4mind/server-utils/models/Subscription';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';
import { adminApi } from '@server/middlewares/adminApi';

const NO_REPORTER: FeedbackReporterSummary = { reporter: null };

/** Individual plan name first, then a team seat, then a paid subscription whose price is not in the plan map. */
async function reporterPlan(userId: string): Promise<string | null> {
  const subscriptions = await subscriptionRepository.findActiveUserSubscriptions(userId);
  const named = subscriptions.map(sub => SUBSCRIPTION_PLANS_MAP[sub.priceId]?.name).find(name => !!name);
  if (named) return named;
  // Same org lookup as users/[userId]/subscriptions.ts.
  const { data: organizations } = await organizationRepository.search(
    '',
    { userId },
    { page: 1, limit: 100 },
    { field: 'name', direction: 'asc' }
  );
  const teamSubscriptions = await Promise.all(
    organizations.map(org =>
      subscriptionRepository.findActiveSubscriptionsByOwner(SubscriptionOwnerType.Organization, org.id)
    )
  );
  if (teamSubscriptions.some(subs => subs.length > 0)) return 'Team';
  return subscriptions.length > 0 ? 'Unknown plan' : null;
}

/**
 * Reporter facts for the feedback drawer, gated like the Users page read. Carries no name or email;
 * the plan is included only for callers who may read subscriptions (the Credits page read).
 */
const handler = adminApi({ auth: 'jwtOnly', adminPermissions: { GET: MODERATION_PAGE_READ } }).get(async (req, res) => {
  const id = String(req.query.id ?? '');
  if (!isValidObjectId(id)) throw new NotFoundError('Feedback not found');
  const feedback = await FeedbackModel.findById(id).select('userId userEmail userIdVerified createdAt').lean();
  if (!feedback) throw new NotFoundError('Feedback not found');

  // An unauthenticated submission stores the request body's userId, so it names no one reliably.
  // Session ids are always lowercase hex; any other casing came from a request body.
  const { userId, userIdVerified } = feedback;
  if (userIdVerified === false || !isValidObjectId(userId) || userId !== userId.toLowerCase()) {
    return res.json(NO_REPORTER);
  }

  const user = await userRepository.findById(userId);
  // Reports from before userIdVerified was recorded are trusted only while their email matches the account.
  if (userIdVerified !== true) {
    const storedEmail = feedback.userEmail?.trim().toLowerCase();
    if (!user?.email || !storedEmail || user.email.trim().toLowerCase() !== storedEmail) {
      return res.json(NO_REPORTER);
    }
  }

  const canReadPlan = CREDITS_PAGE_READ.some(permission => hasAdminPermission(req.user, permission));
  const [plan, earlierReports] = await Promise.all([
    user && canReadPlan ? reporterPlan(userId) : null,
    FeedbackModel.countDocuments({ userId, userIdVerified: { $ne: false }, createdAt: { $lt: feedback.createdAt } }),
  ]);

  const response: FeedbackReporterSummary = {
    reporter: {
      userId,
      exists: !!user,
      ...(canReadPlan ? { plan } : {}),
      createdAt: user?.createdAt ? new Date(user.createdAt).toISOString() : null,
      isBanned: !!user?.isBanned,
      earlierReports,
    },
  };
  return res.json(response);
});

export default handler;
