import { Request, Response } from 'express';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@server/utils/errors';
import { MailService, type EmailConfigStatus } from '@server/utils/mailer';
import { Config } from '@server/utils/config';
import mongoose from 'mongoose';
import { getOktaConfigStatus } from '@server/auth/oktaOidcClient';
import { validateEncryptionKey, validateJwtSecret } from '@server/security/tier1SecretValidators';

export interface OAuthProviderStatus {
  configured: boolean;
  missingSecrets: string[];
  /** URL format warnings */
  warnings?: string[];
  /** Whether SST secrets are configured */
  sstConfigured?: boolean;
  /** Whether database IDP config exists */
  databaseConfigured?: boolean;
  /** Which config source will be used */
  effectiveSource?: 'sst' | 'database' | 'none';
}

export interface OAuthConfigStatus {
  google: OAuthProviderStatus;
  github: OAuthProviderStatus;
  okta: OAuthProviderStatus;
}

export interface SystemHealthResponse {
  email: EmailConfigStatus;
  database: {
    type: string;
    connected: boolean;
    readyState: number;
  };
  oauth: OAuthConfigStatus;
}

/**
 * Validates that a URL is a valid HTTPS URL
 */
function isValidHttpsUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Get the configuration status for OAuth providers
 */
async function getOAuthConfigStatus(): Promise<OAuthConfigStatus> {
  const googleMissing: string[] = [];
  if (!Config.GOOGLE_CLIENT_ID) googleMissing.push('GOOGLE_CLIENT_ID');
  if (!Config.GOOGLE_CLIENT_SECRET) googleMissing.push('GOOGLE_CLIENT_SECRET');

  const githubMissing: string[] = [];
  if (!Config.GITHUB_CLIENT_ID) githubMissing.push('GITHUB_CLIENT_ID');
  if (!Config.GITHUB_CLIENT_SECRET) githubMissing.push('GITHUB_CLIENT_SECRET');

  // Get Okta configuration status from shared helper first
  // This determines which config source is active (database takes precedence)
  const oktaStatus = await getOktaConfigStatus();
  const { sstConfigured, databaseConfigured, effectiveSource, effectiveConfig } = oktaStatus;

  // SST secrets that are missing (for reference, but database can override)
  const oktaSstMissing: string[] = [];
  if (!Config.OKTA_AUDIENCE) oktaSstMissing.push('OKTA_AUDIENCE');
  if (!Config.OKTA_CLIENT_ID) oktaSstMissing.push('OKTA_CLIENT_ID');
  if (!Config.OKTA_CLIENT_SECRET) oktaSstMissing.push('OKTA_CLIENT_SECRET');

  // These SST secrets are always required for Okta OAuth flow to complete:
  // - JWT_SECRET: Signs the state token (CSRF protection) - min 64 chars recommended for HS256
  // - SECRET_ENCRYPTION_KEY: Encrypts OAuth tokens before storing in database - must be 64 hex chars
  const oktaMissing: string[] = [];
  const oktaWarnings: string[] = [];

  // Check JWT_SECRET using shared validator
  const jwtResult = validateJwtSecret(Config.JWT_SECRET);
  if (!jwtResult.isValid) {
    if (jwtResult.status === 'missing' || jwtResult.status === 'placeholder') {
      oktaMissing.push('JWT_SECRET');
    } else if (jwtResult.status === 'invalid' || jwtResult.status === 'insecure') {
      oktaWarnings.push(jwtResult.message || 'JWT_SECRET is invalid');
    }
  } else if (jwtResult.status === 'warning') {
    oktaWarnings.push(`${jwtResult.message} Generate a new one with: openssl rand -base64 48`);
  }

  // Check SECRET_ENCRYPTION_KEY using shared validator
  const encryptionResult = validateEncryptionKey(Config.SECRET_ENCRYPTION_KEY);
  if (!encryptionResult.isValid) {
    if (encryptionResult.status === 'missing' || encryptionResult.status === 'placeholder') {
      oktaMissing.push('SECRET_ENCRYPTION_KEY');
    } else if (encryptionResult.status === 'invalid') {
      oktaMissing.push(`SECRET_ENCRYPTION_KEY (${encryptionResult.message || 'invalid format'})`);
    }
  }

  // Only show Okta config secrets as missing if neither source is configured
  if (effectiveSource === 'none') {
    oktaMissing.push(...oktaSstMissing);
  }

  // Validate the EFFECTIVE config's audience URL (not SST if database is active)
  const effectiveAudience = effectiveConfig?.audience;

  if (effectiveAudience && !isValidHttpsUrl(effectiveAudience)) {
    const sourceLabel = effectiveSource === 'database' ? 'Database IDP' : 'SST';
    oktaWarnings.push(`Okta audience (${sourceLabel}) must be a valid HTTPS URL (e.g., https://your-domain.okta.com)`);
  }

  // Check for common audience URL mistakes in the effective config
  if (effectiveAudience?.includes('/oauth2/')) {
    const sourceLabel = effectiveSource === 'database' ? 'Database IDP' : 'SST';
    oktaWarnings.push(
      `Okta audience (${sourceLabel}) should be the base Okta domain only (e.g., https://your-domain.okta.com), not the full OAuth path`
    );
  }

  // Okta is fully configured only if:
  // 1. Either SST or database config is complete (for Okta credentials)
  // 2. AND JWT_SECRET is configured and valid (required for OAuth state signing)
  // 3. AND SECRET_ENCRYPTION_KEY is configured AND valid format (required for token storage)
  // JWT_SECRET with warning status is still considered valid (just not optimal)
  const jwtSecretConfigured = jwtResult.isValid;
  const encryptionKeyValid = encryptionResult.isValid;
  const oktaConfigured = (sstConfigured || databaseConfigured) && jwtSecretConfigured && encryptionKeyValid;

  return {
    google: {
      configured: googleMissing.length === 0,
      missingSecrets: googleMissing,
    },
    github: {
      configured: githubMissing.length === 0,
      missingSecrets: githubMissing,
    },
    okta: {
      configured: oktaConfigured,
      missingSecrets: oktaMissing,
      warnings: oktaWarnings.length > 0 ? oktaWarnings : undefined,
      sstConfigured,
      databaseConfigured,
      effectiveSource,
    },
  };
}

const handler = baseApi().get(async (req: Request, res: Response) => {
  if (!req.user?.isAdmin) {
    throw new ForbiddenError('Unauthorized. Admin access required.');
  }

  try {
    const mailService = new MailService();
    const emailStatus = mailService.getConfigStatus();
    const oauthStatus = await getOAuthConfigStatus();

    const response: SystemHealthResponse = {
      email: emailStatus,
      database: {
        type: process.env.MAIN_DB_TYPE || 'MongoAtlas',
        connected: mongoose.connection.readyState === 1,
        readyState: mongoose.connection.readyState,
      },
      oauth: oauthStatus,
    };

    return res.json(response);
  } catch (error) {
    console.error('Error getting system health:', error);
    return res.status(500).json({
      error: 'Failed to get system health status',
    });
  }
});

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
