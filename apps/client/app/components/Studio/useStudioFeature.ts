import { isStudioFeatureOpen, studioFeatureSettingKeys, type StudioFeature } from '@bike4mind/common';
import { useUser } from '@client/app/contexts/UserContext';
import { useFeatureEnabled } from '@client/app/hooks/useFeatureEnabled';
import { useAdminSettingsCache } from '@client/app/hooks/useAdminSettingsCache';
import { useAccessToken } from '@client/app/hooks/useAccessToken';

/**
 * Whether a Studio rebuild feature is open to the current user: its admin flag (and its parent's) is on
 * and the user is an admin. False while settings load, so nothing flashes in. The server side is requireStudioFeature /
 * isStudioFeatureEnabled in @bike4mind/server-utils/middlewares/studioFeatureFlag.
 */
export const useStudioFeature = (feature: StudioFeature): boolean => {
  const isAdmin = useUser(s => s.isAdmin ?? false);
  const { isAdminFeatureEnabled } = useFeatureEnabled();
  return isStudioFeatureOpen({ isAdmin, flagEnabled: studioFeatureSettingKeys(feature).every(isAdminFeatureEnabled) });
};

/**
 * True until the admin settings and user preferences behind useStudioFeature have loaded. The Studio flags are not
 * publicSafe, so a signed-in user waits for the authenticated settings fetch (or its failure): until then they read as
 * compiled-in defaults, even after the public settings let useFeatureEnabled report loaded. Same rule as
 * IntegrationsGallery's flagsReady.
 */
export const useStudioFeaturesLoading = (): boolean => {
  const featuresLoading = useFeatureEnabled().isLoading;
  const { authedSettingsLoaded, error } = useAdminSettingsCache();
  const signedIn = useAccessToken(state => !!state.accessToken);
  return featuresLoading || (signedIn && !authedSettingsLoaded && !error);
};
