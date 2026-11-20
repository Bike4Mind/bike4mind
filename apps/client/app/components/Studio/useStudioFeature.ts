import {
  isFreeTierExempt,
  PAID_PLAN_ENTITLEMENT_KEY,
  resolveStudioFeatureAccess,
  STUDIO_FEATURE_AUDIENCE_SETTING,
  studioFeatureAudience,
  studioFeatureSettingKeys,
  type StudioFeature,
  type StudioFeatureAccess,
} from '@bike4mind/common';
import { useUser } from '@client/app/contexts/UserContext';
import { useEntitlements } from '@client/app/hooks/data/entitlements';
import { useFeatureEnabled } from '@client/app/hooks/useFeatureEnabled';
import { useAdminSettingsCache } from '@client/app/hooks/useAdminSettingsCache';
import { useAccessToken } from '@client/app/hooks/useAccessToken';

const useStudioAudience = (feature: StudioFeature) => {
  const isAdmin = useUser(s => s.isAdmin ?? false);
  const tags = useUser(s => s.currentUser?.tags);
  // Same cache as the feature flags, so useStudioFeaturesLoading's wait on it covers the audience too.
  const { getSetting } = useAdminSettingsCache();
  const audienceKey = STUDIO_FEATURE_AUDIENCE_SETTING[feature];
  const audience = studioFeatureAudience(feature, audienceKey ? getSetting(audienceKey) : undefined);
  const viewer = { isAdmin, tags };
  // Only a paid audience needs the plan, and an exempt viewer never does (the server skips the read the same way).
  return { viewer, audience, needsPlan: audience === 'paid' && !isFreeTierExempt(viewer) };
};

/**
 * What the current user gets for a Studio rebuild feature: 'open', 'upgrade' (a free user of a paid feature) or
 * 'closed'. Reads the same facts as the server (the feature's flags, its audience setting, the user's admin/developer
 * status and the plan:paid entitlement) and applies resolveStudioFeatureAccess to them. Closed while settings load, so
 * nothing flashes in; pair it with useStudioFeaturesLoading before showing 'upgrade' or not-found. The server side is
 * requireStudioFeature / isStudioFeatureEnabled in @bike4mind/server-utils/middlewares/studioFeatureFlag.
 */
export const useStudioFeatureAccess = (feature: StudioFeature): StudioFeatureAccess => {
  const { viewer, audience, needsPlan } = useStudioAudience(feature);
  const { isAdminFeatureEnabled } = useFeatureEnabled();
  const { data: entitlements } = useEntitlements({ enabled: needsPlan });
  return resolveStudioFeatureAccess({
    viewer,
    hasPaidPlan: entitlements?.includes(PAID_PLAN_ENTITLEMENT_KEY) ?? false,
    flagEnabled: studioFeatureSettingKeys(feature).every(isAdminFeatureEnabled),
    audience,
  });
};

/** Whether a Studio rebuild feature is open to the current user (the 'open' outcome of useStudioFeatureAccess). */
export const useStudioFeature = (feature: StudioFeature): boolean => useStudioFeatureAccess(feature) === 'open';

/**
 * True until the admin settings and user preferences behind useStudioFeatureAccess have loaded. The Studio flags are not
 * publicSafe, so a signed-in user waits for the authenticated settings fetch (or its failure): until then they read as
 * compiled-in defaults, even after the public settings let useFeatureEnabled report loaded. Same rule as
 * IntegrationsGallery's flagsReady. Pass `feature` to also wait on the plan entitlement a paid audience needs, so a
 * paying user never sees 'upgrade' before it arrives (a failed entitlement read ends the wait and reads as free).
 */
export const useStudioFeaturesLoading = (feature?: StudioFeature): boolean => {
  const featuresLoading = useFeatureEnabled().isLoading;
  const { authedSettingsLoaded, error } = useAdminSettingsCache();
  const signedIn = useAccessToken(state => !!state.accessToken);
  const { needsPlan } = useStudioAudience(feature ?? 'createV2');
  const entitlements = useEntitlements({ enabled: feature !== undefined && needsPlan });
  const waitingOnPlan = feature !== undefined && needsPlan && entitlements.data === undefined && !entitlements.isError;
  return featuresLoading || (signedIn && !authedSettingsLoaded && !error) || waitingOnPlan;
};
