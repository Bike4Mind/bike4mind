import { isStudioFeatureOpen, studioFeatureSettingKeys, type StudioFeature } from '@bike4mind/common';
import { useUser } from '@client/app/contexts/UserContext';
import { useFeatureEnabled } from '@client/app/hooks/useFeatureEnabled';

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
