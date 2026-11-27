import { useMemo } from 'react';
import { useUser } from '@client/app/contexts/UserContext';
import { useAdminSettingsCache } from '@client/app/hooks/useAdminSettingsCache';
import { userIsDeveloper } from '@client/app/utils/user';
import { useEntitlements } from './entitlements';

/**
 * Client mirror of the Overwatch overlay's `requestHasOverwatchAccess`: admin || developer ||
 * holds `overwatch:pro`. Same synchronous fast path as useOptiAccess, so the entitlement fetch
 * only runs for a user with no admin/developer signal.
 */
export function useOverwatchAccess(): boolean {
  const currentUser = useUser(s => s.currentUser);
  const isAdmin = useUser(s => s.isAdmin);
  const syncGranted = isAdmin || userIsDeveloper(currentUser);
  const { data: entitlements } = useEntitlements({ enabled: !syncGranted });
  return syncGranted || (entitlements ?? []).includes('overwatch:pro');
}

/**
 * Admin or developer (`bypass`), else the user's entitlement keys: what a contributed API-key scope's
 * `requiredEntitlement` is checked against. Same fast path as useOverwatchAccess.
 */
export function useApiKeyScopeEntitlements(): { bypass: boolean; entitlements: ReadonlySet<string> } {
  const currentUser = useUser(s => s.currentUser);
  const isAdmin = useUser(s => s.isAdmin);
  const bypass = isAdmin || userIsDeveloper(currentUser);
  const { data: entitlements } = useEntitlements({ enabled: !bypass });
  return useMemo(() => ({ bypass, entitlements: new Set(bypass ? [] : (entitlements ?? [])) }), [bypass, entitlements]);
}

/** Whether the `EnableHearth` admin setting is on - the gate every pages/api/hearth route enforces. */
export function useHearthEnabled(): boolean {
  return useAdminSettingsCache().isFeatureEnabled('EnableHearth');
}
