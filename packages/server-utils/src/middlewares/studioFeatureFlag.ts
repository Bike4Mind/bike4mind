import {
  PAID_PLAN_ENTITLEMENT_KEY,
  resolveSettingDefinition,
  resolveStudioFeatureAccess,
  STUDIO_FEATURE_AUDIENCE_SETTING,
  studioFeatureAudience,
  studioFeatureSettingKeys,
  type StudioFeature,
} from '@bike4mind/common';
import { adminSettingsRepository } from '@bike4mind/database';
import { getSettingByName } from '@bike4mind/utils';
import type { Request, RequestHandler } from 'express';
import { getRequestEntitlements, type EntitlementRequest } from '../entitlements';
import { isFeatureEnabled, requireFeature } from './featureFlag';

/**
 * Whether a Studio rebuild feature is open to the requesting user: the admin flag (and its parent's) is on and
 * the user passes the feature's audience (studioFeatureAudience). The plan is read (getRequestEntitlements, one
 * subscription read per request) only for a paid audience and a viewer the rule does not already open, so
 * admin-only mode and exempt users pay nothing. No user returns before any read. A read error propagates, so
 * callers fail closed. Mirrors the client's useStudioFeatureAccess (both apply resolveStudioFeatureAccess).
 */
export async function isStudioFeatureEnabled(feature: StudioFeature, req: Request): Promise<boolean> {
  const user = (req as { user?: { isAdmin?: boolean; tags?: string[] } }).user;
  if (!user) return false;
  const settingsOn = await Promise.all(studioFeatureSettingKeys(feature).map(key => isFeatureEnabled(key)));
  const audienceKey = STUDIO_FEATURE_AUDIENCE_SETTING[feature];
  const audience = studioFeatureAudience(
    feature,
    audienceKey &&
      ((await getSettingByName(audienceKey, { adminSettings: adminSettingsRepository })) ??
        resolveSettingDefinition(audienceKey)?.defaultValue)
  );
  const rule = { viewer: user, flagEnabled: settingsOn.every(Boolean), audience };
  const access = resolveStudioFeatureAccess({ ...rule, hasPaidPlan: false });
  if (access !== 'upgrade') return access === 'open';
  // Express's Request shares no properties with the structural EntitlementRequest, so TS needs the cast.
  const entitlements = await getRequestEntitlements(req as EntitlementRequest);
  return (
    resolveStudioFeatureAccess({ ...rule, hasPaidPlan: entitlements.includes(PAID_PLAN_ENTITLEMENT_KEY) }) === 'open'
  );
}

/**
 * Route middleware for an API path behind a Studio rebuild flag. Answers 403 FEATURE_DISABLED, the same
 * body requireFeatureEnabled sends, whether the flag is off, the feature is admin-only and the caller is not an
 * admin, or the feature is paid and the caller is on a free plan, so the response does not reveal which one it was.
 */
export const requireStudioFeature = (feature: StudioFeature): RequestHandler =>
  requireFeature(req => isStudioFeatureEnabled(feature, req), `Studio feature ${feature}`);
