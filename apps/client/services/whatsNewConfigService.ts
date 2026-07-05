import { Logger } from '@bike4mind/observability';
import { AdminSettings } from '@bike4mind/database';
import { WhatsNewConfig, WhatsNewConfigSchema, WHATS_NEW_VALIDATION_LIMITS } from '@bike4mind/common';

// Maximum number of config history entries to keep
const MAX_HISTORY_ENTRIES = 10;

const DEFAULT_CONFIG: WhatsNewConfig = {
  // Model configuration
  modelId: 'gpt-4o-mini',
  temperature: 0.7,
  maxTokens: 2000,
  timeoutMs: 120000,
  // Modal configuration
  modalPriority: 10,
  modalExpiryDays: 30,
  maxPreviousModals: 10,
  // Validation limits
  titleMaxLength: 100,
  subtitleMaxLength: 200,
  descriptionMaxLength: 2000,
  // Sanitization limits
  maxCommits: 50,
  maxPullRequests: 20,
  maxReleaseBodyLength: 2000,
  maxCommitMessageLength: 200,
  maxPRBodyLength: 500,
  maxChangelogLength: 1000,
  repository: 'MillionOnMars/lumina5',
  targetBranch: 'prod',
};

export class WhatsNewConfigService {
  private static logger = new Logger({ metadata: { service: 'WhatsNewConfigService' } });

  /**
   * Get What's New configuration from database, or return default if not found
   */
  static async getConfig(): Promise<WhatsNewConfig> {
    try {
      const setting = await AdminSettings.findOne({
        settingName: 'whatsNewConfig',
      })
        .lean()
        .exec();

      if (!setting) {
        this.logger.info("What's New config not found, using defaults");
        return DEFAULT_CONFIG;
      }

      try {
        // Clamp timeoutMs to valid range before parsing (handles existing configs with old max value)
        const rawConfig = this.clampStoredConfig(setting.settingValue);
        const config = WhatsNewConfigSchema.parse(rawConfig);
        return config;
      } catch (parseError) {
        this.logger.error("Invalid What's New config in database, using defaults:", parseError);
        return DEFAULT_CONFIG;
      }
    } catch (error) {
      this.logger.error("Error getting What's New config:", error);
      return DEFAULT_CONFIG;
    }
  }

  /**
   * Update What's New configuration in database
   */
  static async updateConfig(config: WhatsNewConfig): Promise<void> {
    try {
      const validatedConfig = WhatsNewConfigSchema.parse(config);

      await AdminSettings.findOneAndUpdate(
        { settingName: 'whatsNewConfig' },
        {
          settingName: 'whatsNewConfig',
          settingValue: validatedConfig,
        },
        { upsert: true }
      );

      this.logger.info("Updated What's New configuration:", validatedConfig);
    } catch (error) {
      this.logger.error("Error updating What's New config:", error);
      throw new Error("Failed to update What's New configuration");
    }
  }

  /**
   * Get the current configuration (returns null if not found, doesn't use defaults)
   * Useful for admin UI to show whether a custom config exists
   */
  static async getCurrentConfig(): Promise<WhatsNewConfig | null> {
    try {
      const setting = await AdminSettings.findOne({
        settingName: 'whatsNewConfig',
      })
        .lean()
        .exec();

      if (!setting) {
        return null;
      }

      const rawConfig = this.clampStoredConfig(setting.settingValue);
      return WhatsNewConfigSchema.parse(rawConfig);
    } catch (error) {
      this.logger.error("Error getting current What's New config:", error);
      return null;
    }
  }

  /**
   * Get the default configuration
   */
  static getDefaultConfig(): WhatsNewConfig {
    return { ...DEFAULT_CONFIG };
  }

  /**
   * Clamp timeoutMs to current valid range before Zod parsing.
   * Handles existing DB configs saved under the old max (600000ms).
   * Returns a new object to avoid mutating the source.
   */
  private static clampStoredConfig(raw: unknown): Record<string, unknown> {
    const rawConfig = raw as Record<string, unknown>;
    if (rawConfig && typeof rawConfig.timeoutMs === 'number') {
      const maxTimeout = WHATS_NEW_VALIDATION_LIMITS.timeoutMs.max;
      if (rawConfig.timeoutMs > maxTimeout) {
        this.logger.warn(`Clamping timeoutMs from ${rawConfig.timeoutMs}ms to ${maxTimeout}ms (max limit reduced)`);
        return { ...rawConfig, timeoutMs: maxTimeout };
      }
    }
    return rawConfig;
  }

  /**
   * Save current config to history before updating
   */
  private static async saveToHistory(
    config: WhatsNewConfig,
    metadata: {
      userId: string;
      username: string;
      timestamp: Date;
    }
  ): Promise<void> {
    try {
      const historyDoc = await AdminSettings.findOne({
        settingName: 'whatsNewConfigHistory',
      });

      const historyEntry = {
        config,
        metadata,
      };

      if (historyDoc) {
        const history: Array<{
          config: WhatsNewConfig;
          metadata: {
            userId: string;
            username: string;
            timestamp: Date;
          };
        }> = Array.isArray(historyDoc.settingValue) ? historyDoc.settingValue : [];
        history.unshift(historyEntry);

        const trimmedHistory = history.slice(0, MAX_HISTORY_ENTRIES);

        await AdminSettings.findOneAndUpdate(
          { settingName: 'whatsNewConfigHistory' },
          { settingValue: trimmedHistory }
        );
      } else {
        await AdminSettings.create({
          settingName: 'whatsNewConfigHistory',
          settingValue: [historyEntry],
        });
      }

      this.logger.info('Saved configuration to history', metadata);
    } catch (error) {
      // Non-fatal: don't fail the update if history saving fails
      this.logger.error('Error saving configuration history:', error);
    }
  }

  /**
   * Update What's New configuration with history tracking
   */
  static async updateConfigWithHistory(config: WhatsNewConfig, userId: string, username: string): Promise<void> {
    try {
      const currentConfig = await this.getCurrentConfig();

      if (currentConfig) {
        await this.saveToHistory(currentConfig, {
          userId,
          username,
          timestamp: new Date(),
        });
      }

      await this.updateConfig(config);
    } catch (error) {
      this.logger.error("Error updating What's New config with history:", error);
      throw new Error("Failed to update What's New configuration");
    }
  }

  /**
   * Get configuration history
   */
  static async getConfigHistory(): Promise<
    Array<{
      config: WhatsNewConfig;
      metadata: {
        userId: string;
        username: string;
        timestamp: Date;
      };
    }>
  > {
    try {
      const historyDoc = await AdminSettings.findOne({
        settingName: 'whatsNewConfigHistory',
      })
        .lean()
        .exec();

      if (!historyDoc || !Array.isArray(historyDoc.settingValue)) {
        return [];
      }

      // Clamp out-of-range values in history entries for display
      return historyDoc.settingValue.map(
        (entry: { config: WhatsNewConfig; metadata: { userId: string; username: string; timestamp: Date } }) => ({
          ...entry,
          config: WhatsNewConfigSchema.parse(this.clampStoredConfig(entry.config)),
        })
      );
    } catch (error) {
      this.logger.error("Error getting What's New config history:", error);
      return [];
    }
  }

  /**
   * Restore a configuration from history
   */
  static async restoreFromHistory(index: number, userId: string, username: string): Promise<WhatsNewConfig> {
    try {
      const history = await this.getConfigHistory();

      if (index < 0 || index >= history.length) {
        throw new Error('Invalid history index');
      }

      const historyEntry = history[index];
      const configToRestore = historyEntry.config;

      // Clamp timeoutMs to valid range before parsing (handles history entries with old max value)
      const rawConfig = this.clampStoredConfig(configToRestore);
      const validatedConfig = WhatsNewConfigSchema.parse(rawConfig);

      // Also saves the current config to history
      await this.updateConfigWithHistory(validatedConfig, userId, username);

      this.logger.info('Restored configuration from history', {
        index,
        userId,
        username,
        originalTimestamp: historyEntry.metadata.timestamp,
      });

      return validatedConfig;
    } catch (error) {
      this.logger.error('Error restoring configuration from history:', error);
      throw new Error('Failed to restore configuration from history');
    }
  }
}
