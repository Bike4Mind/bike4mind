import { SettingKey, settingsMap } from '@bike4mind/common';
import { AdminSettings } from '@bike4mind/database/infra';
import { RequestHandler } from 'express';

/**
 * Single source of truth for coercing an admin-setting value into a boolean.
 * Shared by {@link requireFeatureEnabled} and any inline conditional flag check
 * (e.g. a per-workId gate) so the parsing can't drift between call sites.
 * Fails closed: unknown types and undefined read as disabled.
 */
export function isSettingEnabled(rawValue: unknown): boolean {
  if (typeof rawValue === 'boolean') return rawValue;
  if (typeof rawValue === 'number') return rawValue === 1;
  if (typeof rawValue === 'string') return rawValue === 'true' || rawValue === '1';
  return false;
}

/**
 * Middleware to enforce server-side feature flag checks.
 * Prevents users from bypassing client-side feature checks via direct API calls.
 *
 * @param featureName - The admin setting key to check (e.g., 'EnableQuestMaster')
 * @returns Express middleware that returns 403 if feature is disabled
 */
export const requireFeatureEnabled =
  (featureName: SettingKey): RequestHandler =>
  async (req, res, next) => {
    try {
      const setting = await AdminSettings.findOne({ settingName: featureName });

      const defaultValue = settingsMap[featureName]?.defaultValue;
      const isEnabled = isSettingEnabled(setting?.settingValue ?? defaultValue);

      if (!isEnabled) {
        return res.status(403).json({
          error: 'Feature not available',
          code: 'FEATURE_DISABLED',
          request_id: req.requestId,
        });
      }

      next();
    } catch (error) {
      console.error(`Error checking feature flag ${featureName}:`, error);
      // Fail closed - deny access on error to be safe
      return res.status(500).json({
        error: 'Unable to verify feature access',
        request_id: req.requestId,
      });
    }
  };
