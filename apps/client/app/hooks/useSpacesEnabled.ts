import { useAdminSettingsCache } from '@client/app/hooks/useAdminSettingsCache';

/**
 * EnableSpaces is not in the public settings projection, so before the authenticated fetch lands it
 * reads as the compiled-in default. `ready` is false until then; callers show nothing while it is.
 */
export function useSpacesEnabled(): { enabled: boolean; ready: boolean } {
  const { isFeatureEnabled, authedSettingsLoaded } = useAdminSettingsCache();
  const ready = !!authedSettingsLoaded;
  return { ready, enabled: ready && isFeatureEnabled('EnableSpaces') };
}
