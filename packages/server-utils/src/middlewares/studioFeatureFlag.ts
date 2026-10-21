import { isStudioFeatureOpen, studioFeatureSettingKeys, type StudioFeature } from '@bike4mind/common';
import type { RequestHandler } from 'express';
import { isFeatureEnabled, requireFeature } from './featureFlag';

type StudioViewer = { isAdmin?: boolean } | null | undefined;

/**
 * Whether a Studio rebuild feature is open to this user: the admin flag (and its parent's) is on and the
 * user is an admin.
 * The non-admin case returns before the settings read. A read error propagates, so callers fail closed.
 * Mirrors the client's useStudioFeature (both apply isStudioFeatureOpen from @bike4mind/common).
 */
export async function isStudioFeatureEnabled(feature: StudioFeature, user: StudioViewer): Promise<boolean> {
  const isAdmin = user?.isAdmin === true;
  if (!isAdmin) return false;
  const settingsOn = await Promise.all(studioFeatureSettingKeys(feature).map(key => isFeatureEnabled(key)));
  return isStudioFeatureOpen({ isAdmin, flagEnabled: settingsOn.every(Boolean) });
}

/**
 * Route middleware for an API path behind a Studio rebuild flag. Answers 403 FEATURE_DISABLED, the same
 * body requireFeatureEnabled sends, both when the flag is off and when the caller is not an admin, so the
 * response does not reveal which one it was.
 */
export const requireStudioFeature = (feature: StudioFeature): RequestHandler =>
  requireFeature(
    // The Request augmentation that declares user lives in apps/client/global.d.ts, outside this package.
    req => isStudioFeatureEnabled(feature, (req as { user?: StudioViewer }).user),
    `Studio feature ${feature}`
  );
