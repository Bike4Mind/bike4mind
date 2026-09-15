import { getUserEntitlements } from '@server/entitlements';
import { baseApi } from '@server/middlewares/baseApi';

/**
 * GET /api/entitlements - the authenticated caller's entitlement keys
 * (subscription- and tag-derived, ACCESS_MODEL.md §3). Consumed by
 * `useEntitlements()` for the `requireEntitlement` route gate.
 *
 * Owner is strictly `req.user` - this endpoint must never accept a
 * userId/ownerId parameter.
 */
const handler = baseApi().get(async (req, res) => {
  // Defensive only - baseApi's auth middleware already 401s unauthenticated
  // requests with this same shape before the handler runs.
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
  }

  const entitlements = await getUserEntitlements({
    id: req.user.id,
    tags: req.user.tags,
    isAdmin: req.user.isAdmin,
    email: req.user.email,
    emailVerified: req.user.emailVerified,
  });

  // User-specific payload behind CloudFront - never cacheable, anywhere.
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json({ entitlements });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
