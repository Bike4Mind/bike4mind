import { BaseSeeder } from './base';
import { SST_PLACEHOLDER_VALUE } from '@bike4mind/common';

/**
 * Tier 1 secrets that must be validated but NEVER stored in DB.
 * These must be set via SST CLI before the app can start.
 *
 * NOTE: No secrets are auto-generated. All Tier 1 secrets must be
 * configured manually via SST CLI to ensure proper security and
 * prevent data loss from regeneration.
 */
const TIER1_REQUIRED_SECRETS = [
  {
    secretName: 'SECRET_ENCRYPTION_KEY',
    description: 'Master encryption key for encrypting secrets in the database',
    minLength: 64, // Must be exactly 64 hex chars (32 bytes)
    validator: (value: string) => /^[a-f0-9]{64}$/i.test(value),
    setupCommand:
      'AWS_PROFILE=<your-profile> pnpm sst secret set SECRET_ENCRYPTION_KEY "$(openssl rand -hex 32)" --stage <stage>',
  },
  {
    secretName: 'SESSION_SECRET',
    description: 'Session cookie signing key',
    minLength: 32,
    validator: (value: string) => value.length >= 32,
    setupCommand:
      'AWS_PROFILE=<your-profile> pnpm sst secret set SESSION_SECRET "$(openssl rand -base64 32)" --stage <stage>',
  },
  {
    secretName: 'JWT_SECRET',
    description: 'JWT signing key for authentication tokens',
    minLength: 32,
    validator: (value: string) => value.length >= 32,
    setupCommand:
      'AWS_PROFILE=<your-profile> pnpm sst secret set JWT_SECRET "$(openssl rand -base64 32)" --stage <stage>',
  },
];

/**
 * SystemSecretsSeeder validates that all required Tier 1 secrets are configured.
 *
 * This seeder:
 * 1. Validates Tier 1 secrets (SECRET_ENCRYPTION_KEY, SESSION_SECRET, JWT_SECRET)
 * 2. Throws an error with CLI instructions if any secret is missing, placeholder, or invalid
 *
 * Security considerations:
 * - All Tier 1 secrets must be set via SST CLI before deployment
 * - No secrets are auto-generated to prevent data loss from regeneration
 * - Tier 2/3 secrets (mail, OAuth, API keys) can be configured via admin GUI
 * - Preview environments skip validation (secrets may not be configured for PR previews)
 */
export class SystemSecretsSeeder extends BaseSeeder {
  async seed(): Promise<void> {
    this.logger.info('Starting SystemSecrets validation...');

    // Skip Tier 1 validation in preview environments - secrets may not be configured
    const isPreview = process.env.IS_PREVIEW === 'true';
    if (isPreview) {
      this.logger.info('Skipping Tier 1 secret validation in preview environment');
      return;
    }

    // Validate Tier 1 secrets (these must be set via SST CLI)
    await this.validateTier1Secrets();

    this.logger.info('SystemSecrets validation complete');
  }

  /**
   * Validate that all Tier 1 secrets are properly configured in SST.
   * These secrets CANNOT be auto-generated - they must be set manually.
   * Throws an error with instructions if any are invalid.
   */
  private async validateTier1Secrets(): Promise<void> {
    const { Resource } = await import('sst');

    for (const secret of TIER1_REQUIRED_SECRETS) {
      const value = (Resource as unknown as Record<string, { value?: string }>)[secret.secretName]?.value;

      // Check if missing or placeholder
      if (!value || value === SST_PLACEHOLDER_VALUE) {
        throw new Error(
          `\n\n` +
            `========================================\n` +
            `REQUIRED SECRET NOT CONFIGURED\n` +
            `========================================\n\n` +
            `Secret: ${secret.secretName}\n` +
            `Description: ${secret.description}\n\n` +
            `This is a Tier 1 infrastructure secret that must be set before deployment.\n` +
            `It cannot be auto-generated because regenerating it would cause data loss.\n\n` +
            `To fix, run:\n` +
            `  ${secret.setupCommand}\n\n` +
            `Then redeploy the application.\n` +
            `========================================\n`
        );
      }

      // Validate format
      if (!secret.validator(value)) {
        throw new Error(
          `\n\n` +
            `========================================\n` +
            `INVALID SECRET FORMAT\n` +
            `========================================\n\n` +
            `Secret: ${secret.secretName}\n` +
            `Description: ${secret.description}\n` +
            `Required: Minimum ${secret.minLength} characters\n` +
            `Current length: ${value.length} characters\n\n` +
            `To fix, run:\n` +
            `  ${secret.setupCommand}\n\n` +
            `WARNING: If you had a valid key before, changing it will cause data loss.\n` +
            `Make sure to backup any encrypted data first.\n` +
            `========================================\n`
        );
      }

      this.logger.info(`Tier 1 secret ${secret.secretName} validated successfully`);
    }
  }
}
