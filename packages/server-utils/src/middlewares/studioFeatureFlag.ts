import { STUDIO_FEATURE_FLAGS, isStudioFeatureOpen, type StudioFeature } from '@bike4mind/common';
import type { RequestHandler } from 'express';
import { isFeatureEnabled } from './featureFlag';

type StudioViewer = { isAdmin?: boolean } | null | undefined;

/**
 * Whether a Studio rebuild feature is open to this user: the admin flag is on and the user is an admin.
 * The non-admin case returns before the settings read. A read error propagates, so callers fail closed.
 * Mirrors the client's useStudioFeature (both apply isStudioFeatureOpen from @bike4mind/common).
 */
export async function isStudioFeatureEnabled(feature: StudioFeature, user: StudioViewer): Promise<boolean> {
  const isAdmin = user?.isAdmin === true;
  if (!isAdmin) return false;
  return isStudioFeatureOpen({ isAdmin, flagEnabled: await isFeatureEnabled(STUDIO_FEATURE_FLAGS[feature]) });
}

/**
 * Route middleware for an API path behind a Studio rebuild flag. Answers 403 FEATURE_DISABLED, the same
 * body requireFeatureEnabled sends, both when the flag is off and when the caller is not an admin, so the
 * response does not reveal which one it was.
 */
export const requireStudioFeature =
  (feature: StudioFeature): RequestHandler =>
  async (req, res, next) => {
    // The Request augmentations that declare user and requestId live in apps/client/global.d.ts,
    // outside this package.
    const { user, requestId } = req as { user?: StudioViewer; requestId?: string };
    try {
      if (!(await isStudioFeatureEnabled(feature, user))) {
        return res
          .status(403)
          .json({ error: 'Feature not available', code: 'FEATURE_DISABLED', request_id: requestId });
      }
      next();
    } catch (error) {
      console.error(`Error checking Studio feature ${feature}:`, error);
      return res.status(500).json({ error: 'Unable to verify feature access', request_id: requestId });
    }
  };
