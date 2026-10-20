import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { OAuthClientModel, type IOAuthClientDocument } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { fetchSeederPassword } from './UserSeeder';

/**
 * Seeds three OAuth clients so QA can exercise the "Sign in with B4M" token
 * endpoints on a PREVIEW with no manual setup. Preview-only (seedDatabase.ts
 * hard-refuses any other stage). Registered LAST and never throws out of seed(),
 * so a failure here cannot abort the users/agents seeded before it
 * (MigrationManager.seed has no per-seeder try/catch).
 *
 * - PREVIEW_PUBLIC_CLIENT_ID: public client (PKCE, no usable secret).
 * - PREVIEW_CONFIDENTIAL_CLIENT_ID: confidential client; its secret is the shared
 *   seeder password (SSM /b4m/ci/seeder-default-password) - the same one the user
 *   accounts use, retrievable by the team, never hardcoded in source.
 * - PREVIEW_FEDERATED_CLIENT_ID: confidential client (same secret) federated on B4M's
 *   own id_tokens (`subjectSource: 'sub'`), so /api/oauth/ai-token and
 *   /api/oauth/federated-admin are testable. B4M signs id_tokens with iss=APP_URL and
 *   aud=clientId (oauthServer.ts generateIdToken), so the seeder Lambda needs APP_URL
 *   (infra/database.ts); without it only this client is skipped.
 *
 * Upsert, not create-if-absent: the seeder Lambda re-runs on every preview deploy, and
 * every seeded field is re-asserted each run so seeder changes reach existing previews
 * (isActive included). The public client's throwaway hash is set on insert only. Uses
 * findOne + save() rather than findOneAndUpdate so full-document validation runs: the
 * federatedIdp subschema validators read `this.subjectSource`, which update validators
 * do not bind to the subdocument.
 *
 * redirectUris are placeholder strings: the token endpoints only string-match
 * redirect_uri and /code returns the code in its JSON body, so no callback host is
 * ever dialed - the whole flow is curl-testable on a preview.
 */
export const PREVIEW_PUBLIC_CLIENT_ID = 'b4m_preview_public';
export const PREVIEW_CONFIDENTIAL_CLIENT_ID = 'b4m_preview_confidential';
export const PREVIEW_FEDERATED_CLIENT_ID = 'b4m_preview_federated';
const PREVIEW_REDIRECT_URI = 'https://example.com/cb';

type SeededClientFields = Pick<IOAuthClientDocument, 'name' | 'tokenEndpointAuthMethod'> &
  Partial<Pick<IOAuthClientDocument, 'clientSecretHash' | 'allowedScopes' | 'federatedIdp'>>;

export class OAuthClientSeeder {
  constructor(private readonly logger: Logger) {}

  private async upsert(
    clientId: string,
    fields: SeededClientFields,
    insertOnly: Partial<Pick<IOAuthClientDocument, 'clientSecretHash'>> = {}
  ): Promise<void> {
    const seeded = {
      redirectUris: [PREVIEW_REDIRECT_URI],
      allowedScopes: ['openid', 'email', 'profile'],
      // Preview clients are relying parties so QA exercises the real scope/audience-bound token +
      // consent path, not a full first-party session (the model default). Never left implicit.
      clientType: 'relying-party' as const,
      isActive: true,
      federatedIdp: undefined,
      ...fields,
    };
    const existing = await OAuthClientModel.findOne({ clientId }).exec();
    const doc = existing ? existing.set(seeded) : new OAuthClientModel({ clientId, ...seeded, ...insertOnly });
    await doc.save();
    this.logger.info(
      `${existing ? 'Updated' : 'Created'} OAuth client: ${clientId} (${fields.tokenEndpointAuthMethod})`
    );
  }

  async seed(): Promise<void> {
    // Preview-only, enforced at the seeder as defense in depth. The seedDatabase.ts Lambda already
    // refuses non-preview stages (and sets IS_PREVIEW=true for a real preview), but MigrationManager
    // .seed() and the `migrate seed` CLI have no stage check - so a direct invocation against a
    // non-preview DB would otherwise mint these usable OAuth clients there. Skip unless IS_PREVIEW.
    if (process.env.IS_PREVIEW !== 'true') {
      this.logger.info('OAuthClientSeeder skipped: not a preview stage (IS_PREVIEW!=true)');
      return;
    }
    try {
      // Public client: auth is via PKCE, so the required secret hash is a random,
      // never-exposed value.
      const throwawayHash = await bcrypt.hash(crypto.randomBytes(32).toString('base64url'), 10);
      await this.upsert(
        PREVIEW_PUBLIC_CLIENT_ID,
        { name: 'Preview Public Client', tokenEndpointAuthMethod: 'none' },
        { clientSecretHash: throwawayHash }
      );

      // Confidential + federated clients: their secret is the shared seeder password, re-hashed
      // each run so a rotated SSM value reaches existing previews.
      const secretHash = await bcrypt.hash(await fetchSeederPassword(), 10);
      await this.upsert(PREVIEW_CONFIDENTIAL_CLIENT_ID, {
        name: 'Preview Confidential Client',
        tokenEndpointAuthMethod: 'client_secret_post',
        clientSecretHash: secretHash,
      });

      // Bare origin, matching appUrlForLambdaEnv, so iss compares equal to the id_token's.
      const appUrl = process.env.APP_URL?.replace(/\/+$/, '');
      if (!appUrl) {
        this.logger.error(`OAuthClientSeeder: APP_URL unset, skipping ${PREVIEW_FEDERATED_CLIENT_ID}`);
        return;
      }
      await this.upsert(PREVIEW_FEDERATED_CLIENT_ID, {
        name: 'Preview Federated Client',
        tokenEndpointAuthMethod: 'client_secret_post',
        clientSecretHash: secretHash,
        allowedScopes: ['openid', 'email', 'profile', 'ai:generate'],
        federatedIdp: {
          issuer: appUrl,
          audience: PREVIEW_FEDERATED_CLIENT_ID,
          jwksUri: `${appUrl}/api/oauth/jwks`,
          subjectSource: 'sub',
        },
      });
    } catch (e: unknown) {
      this.logger.error(
        `OAuthClientSeeder failed (preview OAuth clients not seeded): ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }
}
