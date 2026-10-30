import { useGetSettingsValue, useSettingsFromServer } from '@client/app/hooks/data/settings';

/**
 * Whether this deployment promotes the desktop app (the `showDesktopAppPromo` admin setting).
 * False until the stored settings load, so a deployment that turned it off never flashes the promo.
 */
export function useDesktopPromoEnabled(): boolean {
  const { isSuccess } = useSettingsFromServer();
  const value = useGetSettingsValue('showDesktopAppPromo');
  return isSuccess && String(value) === 'true';
}
