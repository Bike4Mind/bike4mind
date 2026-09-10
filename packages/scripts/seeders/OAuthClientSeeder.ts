import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { OAuthClientModel } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { fetchSeederPassword } from './UserSeeder';

/**
 * Seeds two OAuth clients so QA can exercise the "Sign in with B4M" token
 * endpoints on a PREVIEW with no manual setup. Preview-only (seedDatabase.ts
 * hard-refuses any other stage). Registered LAST and never throws out of seed(),
 * so a failure here cannot abort the users/agents seeded before it
 * (MigrationManager.seed has no per-seeder try/catch).
 *
 * - PREVIEW_PUBLIC_CLIENT_ID: public client (PKCE, no usable secret).
 * - PREVIEW_CONFIDENTIAL_CLIENT_ID: confidential client; its secret is the shared
 *   seeder password (SSM /b4m/ci/seeder-default-password) - the same one the user
 *   accounts use, retrievable by the team, never hardcoded in source.
 *
 * redirectUris are placeholder strings: the token endpoints only string-match
 * redirect_uri and /code returns the code in its JSON body, so no callback host is
 * ever dialed - the whole flow is curl-testable on a preview.
 */
export const PREVIEW_PUBLIC_CLIENT_ID = 'b4m_preview_public';
export const PREVIEW_CONFIDENTIAL_CLIENT_ID = 'b4m_preview_confidential';
const PREVIEW_REDIRECT_URI = 'https://example.com/cb';

export class OAuthClientSeeder {
  constructor(private readonly logger: Logger) {}

  private async createIfAbsent(
    clientId: string,
    fields: {
      name: string;
      pkceRequired: boolean;
      tokenEndpointAuthMethod: 'none' | 'client_secret_post';
      clientSecretHash: string;
    }
  ): Promise<void> {
    const existing = await OAuthClientModel.findOne({ clientId }).exec();
    if (existing) {
      this.logger.info(`OAuth client already exists: ${clientId}, skipping...`);
      return;
    }
    await OAuthClientModel.create({
      clientId,
      redirectUris: [PREVIEW_REDIRECT_URI],
      allowedScopes: ['openid', 'email', 'profile'],
      isActive: true,
      ...fields,
    });
    this.logger.info(`Created OAuth client: ${clientId} (${fields.tokenEndpointAuthMethod})`);
  }

  async seed(): Promise<void> {
    try {
      // Public client: auth is via PKCE, so the required secret hash is a random,
      // never-exposed value.
      const throwawayHash = await bcrypt.hash(crypto.randomBytes(32).toString('base64url'), 10);
      await this.createIfAbsent(PREVIEW_PUBLIC_CLIENT_ID, {
        name: 'Preview Public Client',
        pkceRequired: true,
        tokenEndpointAuthMethod: 'none',
        clientSecretHash: throwawayHash,
      });

      // Confidential client: its secret is the shared seeder password.
      const secretHash = await bcrypt.hash(await fetchSeederPassword(), 10);
      await this.createIfAbsent(PREVIEW_CONFIDENTIAL_CLIENT_ID, {
        name: 'Preview Confidential Client',
        pkceRequired: false,
        tokenEndpointAuthMethod: 'client_secret_post',
        clientSecretHash: secretHash,
      });
    } catch (e: unknown) {
      this.logger.error(
        `OAuthClientSeeder failed (preview OAuth clients not seeded): ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }
}
