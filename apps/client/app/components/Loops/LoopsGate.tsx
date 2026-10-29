import type { ReactNode } from 'react';
import { useAdminSettings } from '@client/app/contexts/AdminSettingsContext';

export const useLoopsEnabled = () => useAdminSettings().getSettingBoolean('EnableLoops', false);

/**
 * Renders the loops pages only while the admin `EnableLoops` setting is on, and nothing otherwise: unlike
 * ExperimentalFeatureGate there is no "enable it in settings" panel, since users cannot turn this on.
 * Waits for the authed settings so a defaulted `false` does not flash an empty page; if that fetch fails
 * (it never retries) the gate stays shut rather than spinning.
 */
export function LoopsGate({ children, loadingFallback }: { children: ReactNode; loadingFallback: ReactNode }) {
  const { authedSettingsLoaded, error, getSettingBoolean } = useAdminSettings();
  if (!authedSettingsLoaded) return error ? null : <>{loadingFallback}</>;
  return getSettingBoolean('EnableLoops', false) ? <>{children}</> : null;
}
