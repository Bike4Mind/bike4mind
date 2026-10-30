import type { Request } from 'express';
import { JwtRsaVerifier } from 'aws-jwt-verify';
import type { PassportStatic } from 'passport';
import OAuth2Strategy from 'passport-oauth2';
import { z } from 'zod';
import { AuthStrategy, type IAuthProviders } from '@bike4mind/common';
import { encryptAtRest } from '@bike4mind/utils/security';
import { APPLE_ISSUER, generateAppleClientSecret, type AppleConfig } from '@bike4mind/server-utils/auth/appleConfig';
import { authenticateSelfServeProfile } from '@server/utils/auth/verifyCallback';
import { appleOAuthStateStore } from './passportOAuthStateStore';

const APPLE_AUTHORIZATION_URL = `${APPLE_ISSUER}/auth/authorize`;
const APPLE_TOKEN_URL = `${APPLE_ISSUER}/auth/token`;
const APPLE_JWKS_URL = `${APPLE_ISSUER}/auth/keys`;

/** Apple signs the client-secret JWT we send; re-minted once it is this close to expiry. */
const CLIENT_SECRET_TTL_SECONDS = 60 * 60;
const CLIENT_SECRET_REFRESH_MARGIN_MS = 5 * 60 * 1000;

const appleIdTokenClaimsSchema = z.object({
  sub: z.string().min(1),
  email: z.string().optional(),
  // Apple sends this as a boolean or as the string "true".
  email_verified: z.union([z.boolean(), z.enum(['true', 'false'])]).optional(),
});
export type AppleIdTokenClaims = z.infer<typeof appleIdTokenClaimsSchema>;

export type VerifyAppleIdToken = (idToken: string) => Promise<AppleIdTokenClaims>;

/** Verifies signature (Apple JWKS), issuer, audience and expiry. The verifier caches the JWKS across calls. */
export function createAppleIdTokenVerifier(
  clientId: string,
  verifier = JwtRsaVerifier.create({ issuer: APPLE_ISSUER, audience: clientId, jwksUri: APPLE_JWKS_URL })
): VerifyAppleIdToken {
  return async idToken => appleIdTokenClaimsSchema.parse(await verifier.verify(idToken));
}

/**
 * Apple sends the name only on a user's FIRST authorization, as a JSON `user` form field that is
 * not covered by the id_token signature. It is used solely as the display name of a brand-new
 * account; identity and email always come from the verified token.
 */
const appleFirstAuthUserSchema = z.object({
  name: z.object({ firstName: z.string().optional(), lastName: z.string().optional() }).optional(),
});

export function parseAppleDisplayName(rawUser: unknown): string | undefined {
  if (typeof rawUser !== 'string' || rawUser.length > 2048) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(rawUser);
  } catch {
    return undefined;
  }
  const parsed = appleFirstAuthUserSchema.safeParse(json);
  if (!parsed.success) return undefined;
  const { firstName, lastName } = parsed.data.name ?? {};
  const fullName = [firstName, lastName]
    .map(part => part?.trim())
    .filter(Boolean)
    .join(' ');
  return fullName ? fullName.slice(0, 120) : undefined;
}

type AppleOAuth2Client = { _clientSecret: string };

class AppleStrategy extends OAuth2Strategy {
  constructor(
    private readonly appleConfig: AppleConfig,
    options: ConstructorParameters<typeof OAuth2Strategy>[0],
    // any: passport's untyped variadic verify signature
    verify: (...args: any[]) => void
  ) {
    super(options, verify);
    this.refreshClientSecret();
  }

  private secretExpiresAt = 0;

  private refreshClientSecret(): void {
    if (Date.now() < this.secretExpiresAt - CLIENT_SECRET_REFRESH_MARGIN_MS) return;
    // passport-oauth2 takes a static secret at construction; Apple's is a short-lived JWT, so swap it in.
    (this as unknown as { _oauth2: AppleOAuth2Client })._oauth2._clientSecret = generateAppleClientSecret(
      this.appleConfig,
      CLIENT_SECRET_TTL_SECONDS
    );
    this.secretExpiresAt = Date.now() + CLIENT_SECRET_TTL_SECONDS * 1000;
  }

  // Apple requires form_post whenever the name or email scope is requested.
  authorizationParams(): object {
    return { response_mode: 'form_post' };
  }

  authenticate(req: Request, options?: object): void {
    this.refreshClientSecret();
    super.authenticate(req, options);
  }
}

type AppleVerifyDone = (err: unknown, user?: unknown, info?: unknown) => void;

/**
 * (req, accessToken, refreshToken, params, profile, done) - the arity-6 form passport-oauth2 uses with
 * `passReqToCallback`. `params.id_token` carries the identity; the userinfo `profile` is empty for Apple.
 */
export const createAppleVerifyCallback =
  (verifyIdToken: VerifyAppleIdToken) =>
  async (
    req: Request,
    accessToken: string,
    refreshToken: string | undefined,
    params: { id_token?: string },
    _profile: unknown,
    done: AppleVerifyDone
  ): Promise<void> => {
    let claims: AppleIdTokenClaims;
    try {
      if (!params.id_token) throw new Error('Apple token response carried no id_token');
      claims = await verifyIdToken(params.id_token);
    } catch (error) {
      console.error('[AUTH] Apple id_token verification failed:', error);
      done(null, undefined, { code: 'internal' });
      return;
    }

    // Repeat authorizations carry only `sub` (no email, no name); stage-1 matching in
    // authenticateUser finds the account by it.
    const profile = {
      id: claims.sub,
      email: claims.email,
      email_verified: claims.email_verified === true || claims.email_verified === 'true',
      displayName: parseAppleDisplayName((req.query as { user?: unknown } | undefined)?.user),
    };

    // Kept server-side only (never in a response schema) and encrypted: the refresh token is what
    // revokeAppleTokens presents to Apple on account deletion.
    const authProvider: Partial<IAuthProviders> = {
      encrypted: true,
      accessToken: encryptAtRest(accessToken),
      ...(refreshToken ? { refreshToken: encryptAtRest(refreshToken) } : {}),
    };

    await authenticateSelfServeProfile(
      AuthStrategy.Apple,
      req,
      accessToken,
      refreshToken ?? '',
      profile,
      done,
      authProvider
    );
  };

/** Registers the strategy under `apple`; a null config (unset credentials) leaves it unregistered. */
export function registerAppleStrategy(
  passportInstance: Pick<PassportStatic, 'use'>,
  config: AppleConfig | null,
  appUrl = process.env.APP_URL
): boolean {
  if (!config) return false;
  passportInstance.use(
    AuthStrategy.Apple,
    new AppleStrategy(
      config,
      {
        authorizationURL: APPLE_AUTHORIZATION_URL,
        tokenURL: APPLE_TOKEN_URL,
        clientID: config.clientId,
        clientSecret: 'replaced-per-request',
        callbackURL: `${appUrl}/api/auth/apple/callback`,
        store: appleOAuthStateStore,
        passReqToCallback: true,
      },
      createAppleVerifyCallback(createAppleIdTokenVerifier(config.clientId))
    )
  );
  return true;
}
