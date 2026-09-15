import { Resource } from 'sst';
import { WhatsNewSyncConfigSchema } from '@bike4mind/common';
import { AdminSettings } from '@bike4mind/database';
import { validateDistributionUrl } from '@server/services/whatsNewForkFetcher';

/**
 * Environment information for What's New modal sync functionality.
 *
 * This utility provides a single source of truth for determining:
 * - Whether this is the source environment (main production that generates modals)
 * - Whether this is a fork production environment (can sync but defaults to OFF)
 * - Whether the distribution URL is configured (required for sync to work)
 */
export interface WhatsNewEnvInfo {
  /** Current SST stage (e.g., 'production', 'dev', 'pr1234') */
  stage: string;

  /**
   * True if this is the source environment that generates and distributes modals.
   * Determined by ENABLE_WHATS_NEW_DISTRIBUTION=true env var.
   * Only main production should have this set.
   */
  isSourceEnvironment: boolean;

  /**
   * True if this is a fork production environment (stage=production but not source).
   * Fork production defaults to auto-sync OFF (opt-in for independent deployments).
   */
  isForkProduction: boolean;

  /**
   * True if a valid distribution URL is configured (admin override or SST secret).
   * Required for sync functionality to work in non-source environments.
   */
  distributionUrlConfigured: boolean;

  /**
   * Source of the distribution URL: 'admin' if override is set, 'sst' if using SST secret.
   * Undefined if no valid URL is configured.
   */
  distributionUrlSource?: 'admin' | 'sst';

  /**
   * The appropriate default for autoSyncEnabled based on environment type:
   * - Source environment: false (doesn't sync)
   * - Fork production: false (opt-in)
   * - Staging/dev: true (same team, wants latest modals)
   */
  defaultAutoSyncEnabled: boolean;
}

/**
 * Get environment information for What's New modal sync functionality.
 *
 * Use this instead of duplicating environment detection logic across files.
 *
 * @example
 * ```typescript
 * const env = await getWhatsNewEnvInfo();
 *
 * if (env.isSourceEnvironment) {
 *   return res.status(403).json({ error: 'Sync disabled in source environment' });
 * }
 *
 * if (!env.distributionUrlConfigured) {
 *   return res.status(400).json({ error: 'Distribution URL not configured' });
 * }
 * ```
 */
export async function getWhatsNewEnvInfo(): Promise<WhatsNewEnvInfo> {
  const stage = Resource.App.stage;

  // Source environment has ENABLE_WHATS_NEW_DISTRIBUTION=true (main production only)
  // This distinguishes main production from fork "production" stages
  const isSourceEnvironment = process.env.ENABLE_WHATS_NEW_DISTRIBUTION === 'true';

  // Fork production = stage is 'production' but NOT the source environment
  // Fork production defaults to auto-sync OFF (opt-in), staging/dev defaults to ON
  const isForkProduction = stage === 'production' && !isSourceEnvironment;

  // Check admin override first
  let distributionUrlConfigured = false;
  let distributionUrlSource: 'admin' | 'sst' | undefined;

  const setting = await AdminSettings.findOne({ settingName: 'whatsNewSyncConfig' });
  if (setting?.settingValue) {
    const config = WhatsNewSyncConfigSchema.safeParse(setting.settingValue);
    if (config.success && config.data.distributionUrlOverride) {
      const validation = validateDistributionUrl(config.data.distributionUrlOverride);
      if (validation.valid) {
        distributionUrlConfigured = true;
        distributionUrlSource = 'admin';
      }
    }
  }

  // Fall back to SST secret if no valid admin override
  if (!distributionUrlConfigured) {
    const sstUrl = Resource.WHATS_NEW_DISTRIBUTION_URL?.value;
    if (sstUrl && sstUrl !== 'not-configured') {
      const validation = validateDistributionUrl(sstUrl);
      if (validation.valid) {
        distributionUrlConfigured = true;
        distributionUrlSource = 'sst';
      }
    }
  }

  // Determine the appropriate default based on environment type:
  // - Source environment: false (doesn't sync at all)
  // - Fork production: false (opt-in for independent deployments)
  // - Staging/dev: true (same team, wants latest modals)
  const defaultAutoSyncEnabled = isSourceEnvironment ? false : !isForkProduction;

  return {
    stage,
    isSourceEnvironment,
    isForkProduction,
    distributionUrlConfigured,
    distributionUrlSource,
    defaultAutoSyncEnabled,
  };
}
