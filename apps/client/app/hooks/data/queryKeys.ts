/**
 * Shared React Query key constants
 *
 * Using centralized constants prevents cache invalidation bugs from typos
 * or case-sensitivity issues (e.g., 'adminsettings' vs 'adminSettings').
 */

/**
 * Query key for admin settings (object format)
 * Used by AdminSettingsContext - returns Record<string, string | object>
 */
export const ADMIN_SETTINGS_QUERY_KEY = ['adminSettings'] as const;

/**
 * Query key for admin settings (array format)
 * Used by useSettingsFromServer() - returns IAdminSettings[]
 * Both keys must be invalidated when settings are updated
 */
export const ADMIN_SETTINGS_ARRAY_QUERY_KEY = ['adminsettings'] as const;

/**
 * Query key for branding settings (public API)
 * Used by useBrandingSettings() - returns logo settings, tag lines, etc.
 * Must be invalidated when logo settings are updated
 */
export const BRANDING_SETTINGS_QUERY_KEY = ['brandingSettings'] as const;
