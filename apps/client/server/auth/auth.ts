import passport from 'passport';
// TODO Bring back after we fix facebook secrets
// import { Strategy as FacebookStrategy } from 'passport-facebook';
import { AuthStrategy } from '@bike4mind/common';
import ability from '@server/auth/ability';
import { User } from '@bike4mind/database';
import { verifyCallback } from '@server/utils/auth/verifyCallback';
import { Config } from '@server/utils/config';

import { Request, RequestHandler, Response } from 'express';
import { Strategy as GitHubStrategy } from 'passport-github';
import GoogleStrategy from 'passport-google-oauth20';
import { ExtractJwt, Strategy as JwtStrategy } from 'passport-jwt';
import { PassportSamlConfig, Profile as SamlProfile, Strategy as SamlStrategy } from '@node-saml/passport-saml';
import nc from 'next-connect';
import { Logger } from '@bike4mind/observability';
import { dayjs } from '@bike4mind/common';
import { secretRotationRepository } from '@bike4mind/database/infra';
import { authTokenGenerator } from './tokenGenerator';
import { isTokenVersionCurrent } from '@bike4mind/services';
import { githubOAuthStateStore, googleOAuthStateStore } from './passportOAuthStateStore';
import { isPolicyConsentRequired, type ConsentGateUser } from './consentGate';

passport.use(
  new JwtStrategy(
    {
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKeyProvider: async (req, token, done) => {
        // Try current secret
        try {
          authTokenGenerator.verifyToken(token);
          done(null, Config.JWT_SECRET);
        } catch (err) {
          // If verification fails, try previous secret if available
          const jwtSecretRotation = await secretRotationRepository.findByKeyName('JWT_SECRET');
          let prevSecret = undefined;

          // Grace period: allow the previous key if JWT_SECRET was rotated within the last 24 hours
          if (dayjs(jwtSecretRotation?.rotatedAt).isBefore(dayjs().add(1, 'day'))) {
            prevSecret = jwtSecretRotation?.previousKey;
          }

          if (prevSecret) {
            try {
              authTokenGenerator.verifyToken(token, prevSecret);

              done(null, prevSecret);
            } catch (prevErr) {
              done(err);
            }
          } else {
            done(err);
          }
        }
      },
    },
    async (jwt_payload, done) => {
      try {
        const user = await User.findById(jwt_payload.id);
        if (user) {
          if (user.isSystem) return done(null, false);
          // Server-side kill switch: reject tokens whose embedded tokenVersion
          // is stale relative to the user's current version. Tokens issued
          // before this field existed carry no version and normalize to 0, so
          // they remain valid until the user's version is bumped by a revoke.
          if (!isTokenVersionCurrent(jwt_payload.tokenVersion, user.tokenVersion)) {
            return done(null, false);
          }
          (user as any).mfaPending = !!jwt_payload.mfaPending;
          return done(null, user);
        } else {
          return done(null, false);
        }
      } catch (err) {
        // Catch transient DB errors (EPIPE, socket closed) and treat as
        // auth failure to prevent leaking internal details to clients
        // and to avoid unhandled promise rejections in Lambda
        return done(null, false);
      }
    }
  )
);

const handler = nc<Request, Response>();

export const auth = handler
  .use((req, res, next) => {
    // Skip JWT authentication if user is already authenticated (e.g., via API key)
    if (req.user) {
      return next();
    }

    // Custom callback ensures 401 responses are JSON (not plain text "Unauthorized")
    // so that API consumers (OAuth clients, SPAs) can reliably parse error responses.
    passport.authenticate('jwt', { session: false }, (err: Error | null, user: Express.User | false) => {
      if (err) return next(err);
      if (!user) {
        return res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' });
      }
      req.user = user;
      next();
    })(req, res, next);
  })
  .use((req, res, next) => {
    // Block access if mfaPending is true and not an allowed endpoint
    if (req.user && (req.user as any).mfaPending) {
      const allowed = [
        '/api/auth/mfa/setup',
        '/api/auth/mfa/verify-setup',
        '/api/auth/mfa/verify',
        '/api/auth/mfa/cancel-setup',
        '/api/auth/logout',
        '/api/identify', // Allow identify for user data
        '/api/settings/fetch', // Needed by MFAEnforcementWrapper to check enforceMFA setting
        '/api/auth/mfa/status', // Needed by MFAEnforcementWrapper to check user MFA status
      ];

      if (!allowed.some(path => req.url.startsWith(path))) {
        req.logger?.info(`[AUTH] Blocked request to ${req.url} for user ${req.user.id} due to mfaPending.`);
        return res.status(401).json({
          error: 'MFA setup or verification required.',
          mfaPending: true,
        });
      }
    }

    // Abuse gate: block any account that has NOT recorded a versioned AUP/ToS
    // acceptance from authenticated API surface. THIS is the real enforcement for the OAuth/SAML/
    // Okta find-or-create paths (which auto-create an account on first login and never hit the
    // /register form) - the checkbox and the client route guard are both bypassable by a
    // bearer-token curl. Fail-closed: keyed on the ABSENCE of aupAcceptedVersion, so any future
    // creation path that forgets to stamp it is trapped here (safe) rather than let through.
    // System/service accounts are skipped; existing human accounts are backfilled with a sentinel
    // version by the grandfather migration, so they pass. Decision logic lives in consentGate.ts.
    //
    // Returns 403 (not 401): the request IS authenticated, just forbidden until acceptance. 401
    // would trigger the client's token-refresh cascade in ApiContext; 403 is ignored by it, and
    // browser users are routed to /accept-policies by the router beforeLoad guard before any
    // background query hits this.
    if (isPolicyConsentRequired(req.user as ConsentGateUser | undefined, req.url, req.method)) {
      req.logger?.info(`[AUTH] Blocked ${req.url} for user ${req.user!.id} — AUP/ToS acceptance required.`);
      return res.status(403).json({
        error: 'Policy acceptance required.',
        // Included so any client that surfaces error_description (e.g. the device-activation page)
        // shows an accurate message instead of a misleading fallback. See issue #369.
        error_description: 'Accept the Terms of Service and Acceptable Use Policy to continue.',
        policyAcceptanceRequired: true,
      });
    }

    req.logger ??= new Logger();
    req.logger.updateMetadata({ userId: req.user?.id });

    // Attach the CASL ability to the request, if not already set
    if (!req.ability) {
      req.ability = ability(req.user);
    }

    next();
  });

// Only register Google OAuth if properly configured
if (Config.GOOGLE_CLIENT_ID && Config.GOOGLE_CLIENT_ID !== 'not-configured') {
  passport.use(
    AuthStrategy.Google,
    new GoogleStrategy.Strategy(
      {
        clientID: Config.GOOGLE_CLIENT_ID,
        clientSecret: Config.GOOGLE_CLIENT_SECRET,
        callbackURL: process.env.APP_URL + '/api/auth/google/callback',
        store: googleOAuthStateStore,
      },
      verifyCallback(AuthStrategy.Google)
    )
  );
} else {
  console.warn('[AUTH] Google OAuth disabled: GOOGLE_CLIENT_ID not configured');
}

/*
passport.use(
// TODO TURN BACK ON WHEN WE GET THESE SECRETS

new FacebookStrategy(
    {
      clientID: Config.FACEBOOK_CLIENT_ID,
      clientSecret: Config.FACEBOOK_CLIENT_SECRET,
      callbackURL: process.env.APP_URL + '/auth/facebook/callback',
      profileFields: ['email', 'displayName', 'id'],
    },
    verifyCallback('facebook')
  )
);
*/

// Only register GitHub OAuth if properly configured
if (Config.GITHUB_CLIENT_ID && Config.GITHUB_CLIENT_ID !== 'not-configured') {
  passport.use(
    AuthStrategy.Github,
    // tsgo (TypeScript 7.0 RC) only resolves the FINAL constructor overload of
    // passport-github's Strategy - a known divergence for `export =` classes that
    // extend another class - so it wrongly demands the passReqToCallback:true
    // signature and rejects this valid StrategyOptions call. Classic tsc resolves
    // the overloads correctly. Cast around the RC's faulty overload resolution;
    // runtime is unchanged (passReqToCallback defaults to false, so verify receives
    // (accessToken, refreshToken, profile, done)). See typecheck-report.md.
    new (GitHubStrategy as unknown as new (
      options: Record<string, unknown>,
      verify: (...args: any[]) => void
    ) => GitHubStrategy)(
      {
        clientID: Config.GITHUB_CLIENT_ID,
        clientSecret: Config.GITHUB_CLIENT_SECRET,
        callbackURL: process.env.APP_URL + '/api/auth/github/callback',
        store: githubOAuthStateStore,
        // Request the user's email. GitHub omits the email from the basic
        // profile when it is private; with this scope passport-github fetches
        // /user/emails and populates the verified primary. Without it, SSO
        // logins resolve with email=null and fall into the account-create path
        // instead of matching the user's existing account by email.
        scope: ['user:email'],
      },
      verifyCallback(AuthStrategy.Github)
    )
  );
} else {
  console.warn('[AUTH] GitHub OAuth disabled: GITHUB_CLIENT_ID not configured');
}

// Note: Okta authentication is now handled by openid-client in oktaOidcClient.ts
// with proper PKCE support. The passport-oauth2 based Okta strategy has been removed.

interface SamlAuthProvider {
  strategy: AuthStrategy.SAML;
  samlNameId?: string;
  samlSessionIndex?: string;
  samlIdentityProviderId: string;
}

// Dynamic SAML strategy setup - will be configured per request
export const setupSamlStrategy = (idp: {
  _id: string;
  samlConfig?: {
    entryPoint: string;
    issuer: string;
    cert: string;
    callbackUrl?: string;
    decryptionPvk?: string;
    privateCert?: string;
    identifierFormat?: string;
    acceptedClockSkewMs?: number;
    attributeConsumingServiceIndex?: number;
    disableRequestedAuthnContext?: boolean;
    attributeMappings?: {
      email?: string;
      firstName?: string;
      lastName?: string;
      name?: string;
      username?: string;
    };
  };
}): string => {
  const strategyName = `saml-${idp._id}`;
  const requestId = Math.random().toString(36).substr(2, 9);

  console.log(`[SAML-${requestId}] === STARTING SAML STRATEGY SETUP ===`);
  console.log(`[SAML-${requestId}] Setting up SAML strategy for IDP: ${idp._id}`);
  console.log(`[SAML-${requestId}] IDP object keys:`, Object.keys(idp));
  console.log(`[SAML-${requestId}] Full IDP object:`, JSON.stringify(idp, null, 2));

  if (!idp.samlConfig) {
    console.error('SAML configuration missing for IDP:', idp._id);
    throw new Error('SAML configuration missing for IDP');
  }

  if (!idp.samlConfig.entryPoint) {
    console.error('Missing entryPoint in SAML config for IDP:', idp._id);
    throw new Error('SAML entryPoint is required');
  }

  if (!idp.samlConfig.issuer) {
    console.error('Missing issuer in SAML config for IDP:', idp._id);
    throw new Error('SAML issuer is required');
  }

  if (!idp.samlConfig.cert) {
    console.error('Missing cert in SAML config for IDP:', idp._id);
    throw new Error('SAML certificate is required');
  }

  console.log('SAML config validation passed for IDP:', idp._id, {
    entryPoint: idp.samlConfig.entryPoint,
    issuer: idp.samlConfig.issuer,
    hasValidCert: !!idp.samlConfig.cert,
    callbackUrl: idp.samlConfig.callbackUrl || `${process.env.APP_URL}/api/auth/saml/callback`,
  });

  // Clean and format the certificate
  const cleanCert = idp.samlConfig.cert.trim();

  const samlOptions: PassportSamlConfig = {
    entryPoint: idp.samlConfig.entryPoint,
    issuer: process.env.APP_URL!,
    idpIssuer: idp.samlConfig.issuer,
    idpCert: cleanCert,
    callbackUrl: idp.samlConfig.callbackUrl || `${process.env.APP_URL}/api/auth/saml/callback`,
    decryptionPvk: idp.samlConfig.decryptionPvk,
    privateKey: idp.samlConfig.privateCert,
    identifierFormat: idp.samlConfig.identifierFormat || 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    acceptedClockSkewMs: idp.samlConfig.acceptedClockSkewMs,
    attributeConsumingServiceIndex: idp.samlConfig.attributeConsumingServiceIndex?.toString(),
    disableRequestedAuthnContext: idp.samlConfig.disableRequestedAuthnContext || false,
    wantAuthnResponseSigned: false,
    wantAssertionsSigned: false,
  };

  console.log('Creating SAML strategy with options for IDP:', idp._id);

  try {
    passport.use(
      strategyName,
      new SamlStrategy(
        samlOptions,
        async (
          profile: SamlProfile | null,
          done: (err: Error | null, user?: Record<string, unknown>, info?: Record<string, unknown>) => void
        ) => {
          try {
            if (!profile) {
              Logger.error('SAML profile is null');
              return done(new Error('SAML profile is null'));
            }
            Logger.log('SAML profile received:', profile);

            // Extract user info from SAML assertion
            const attributeMappings = idp.samlConfig?.attributeMappings || {};
            const email = (profile[attributeMappings.email || 'email'] as string) || profile.nameID || '';
            const firstName =
              (profile[attributeMappings.firstName || 'firstName'] as string) ||
              (profile['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname'] as string) ||
              '';
            const lastName =
              (profile[attributeMappings.lastName || 'lastName'] as string) ||
              (profile['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname'] as string) ||
              '';
            const name =
              (profile[attributeMappings.name || 'name'] as string) ||
              (profile['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name'] as string) ||
              `${firstName} ${lastName}`.trim() ||
              email;

            // Create a standardized profile object.
            // SAML assertions are signed by the configured IdP and the IdP
            // attests user identity - treat the email as verified for the
            // OAuth-link safety gate in verifyCallback.
            const standardProfile = {
              id: profile.nameID || email,
              emails: [{ value: email, verified: true }],
              displayName: name,
              name: { givenName: firstName, familyName: lastName },
              provider: 'saml',
              _raw: profile,
              _json: profile,
              nameID: profile.nameID,
              sessionIndex: profile.sessionIndex,
            };

            // Create SAML-specific auth provider data
            const authProvider: SamlAuthProvider = {
              strategy: AuthStrategy.SAML,
              samlNameId: profile.nameID,
              samlSessionIndex: profile.sessionIndex,
              samlIdentityProviderId: idp._id,
            };

            // Use the same verification logic as other OAuth providers
            const samlVerifyCallback = verifyCallback(AuthStrategy.SAML);

            await samlVerifyCallback('null', 'null', standardProfile, done, authProvider);
          } catch (error) {
            Logger.error('Error in SAML strategy:', error);
            done(error as Error);
          }
        },
        (
          profile: SamlProfile | null,
          done: (err: Error | null, user?: Record<string, unknown>, info?: Record<string, unknown>) => void
        ) => {
          Logger.error('SAML strategy profile:', profile);
          done(null);
        }
      )
    );

    console.log('SAML strategy created successfully for IDP:', idp._id);
    return strategyName;
  } catch (error) {
    console.error('Error creating SAML strategy for IDP:', idp._id, 'Error:', error);
    throw error;
  }
};

// Note: Okta authentication is now handled by openid-client in oktaOidcClient.ts
// The setupOktaStrategy function has been removed in favor of proper OIDC/PKCE support

passport.serializeUser((user, done) => {
  Logger.log('auth.ts passport.serializeUser user', user);
  done(null, user.id);
});

passport.deserializeUser(async (id: string, done) => {
  return User.findById(id)
    .then(user => done(null, user))
    .catch(err => done(err));
});

export const authMiddleware: RequestHandler[] = [passport.initialize()];

export default passport;
