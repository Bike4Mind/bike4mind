import { signupProtection } from '@server/auth/signupProtection';
import {
  AuthEvents,
  HTTPError,
  InternalServerError,
  TooManyRequestsError,
  UnprocessableEntityError,
  isOAuthClientIdShape,
  redactUserSecretsForSelf,
  throttleSourceForSignal,
  type UserRiskSignalType,
} from '@bike4mind/common';
import {
  adminSettingsRepository,
  registrationInviteRepository,
  userRepository,
  subscriberRepository,
  creditTransactionRepository,
  creditLotRepository,
  pendingOtcTokenRepository,
  authSessionRepository,
  oauthClientRepository,
} from '@bike4mind/database';
import { userService, authSessionService } from '@bike4mind/services';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { withTransaction } from '@bike4mind/db-core';
import { applySignupDomainGrant } from '@server/entitlements/signupDomainGrant';
import { isPartnerDomainSignupAllowed } from '@server/utils/auth/partnerSignupBypass';
import { isOpenRegistrationAllowed } from '@server/utils/auth/openRegistration';
import {
  BOOTSTRAP_ADMIN_EMAIL_ENV,
  claimBootstrapAdmin,
  configuredBootstrapAdminEmail,
  releaseBootstrapAdminClaim,
  resolveBootstrapAdmin,
} from '@server/utils/auth/bootstrapAdmin';
import { applyEmailVerifiedGrants } from '@server/auth/emailVerifiedGrants';
import { refreshSignupRiskScore } from '@server/auth/signupRiskScore';
import { baseApi } from '@server/middlewares/baseApi';
import { checkBlockedIP } from '@server/middlewares/checkBlockedIP';
import {
  OTC_LIMITS,
  OTC_VERIFY_EMAIL_BUDGETS,
  ipSubject,
  otcCounterLimit,
  reserveOtcEmailBudget,
  reserveOtcRegistrationDomainBudget,
} from '@server/utils/otcLimits';
import { authTokenGenerator } from '@server/auth/tokenGenerator';
import { logSignInSuccess, resolveSecondFactor } from '@server/auth/signInSecondFactor';
import { setRefreshCookie } from '@bike4mind/server-utils/auth/refreshCookie';
import { buildSessionDevice } from '@server/auth/sessionDevice';
import { recordLoginEvent, readNetworkMeta, recordSignupNetwork } from '@server/auth/networkMeta';
import { assertSignupNetworkWithinLimits } from '@server/auth/signupNetworkLimits';
import { createSignupGrantRiskCollector } from '@bike4mind/server-utils/auth/signupGrantRisk';
import { Config } from '@bike4mind/server-utils/utils/config';
import { logEvent } from '@server/utils/analyticsLog';
import { getClientIp } from '@bike4mind/server-utils/utils/ip';
import { readConsentedAcquisitionTouches } from '@server/analytics/acquisition';
import { emitSignupForSourceProducts } from '@server/analytics/signupEvents';
import { emitEmailVerifiedFunnelEvents, emitFunnelEvent, recordSignupAcquisition } from '@server/analytics/funnel';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import * as z from 'zod';
import { selfUserResponseSchema } from '@bike4mind/common';
import { respond } from '@server/utils/respond';
import { recordAdminActionForActor, systemAuditActor } from '@server/utils/adminAudit';

interface PendingTokenPayload {
  email: string;
  attempts: number;
  exp: number;
  jti: string;
  challengeVerified?: unknown;
}

const MAX_PENDING_OTC_ATTEMPTS = 5;

// Attribution only: a malformed value is dropped rather than rejected so it can never fail a signup.
function parseSourceClientId(value: unknown): string | undefined {
  return isOAuthClientIdShape(value) ? value : undefined;
}

// Existing-user login spreads the self-view user at the top level next to the access token.
const otcLoginResponseSchema = selfUserResponseSchema.extend({ accessToken: z.string() });
const otcRegistrationResponseSchema = z.object({ user: selfUserResponseSchema, accessToken: z.string() });

// Re-read at verify so turning the kill switch off also stops codes issued before the change. A failed
// read keeps applying, matching what send stored.
async function isSignupBotChecksEnabled(logger: { warn: (...args: unknown[]) => void }): Promise<boolean> {
  try {
    const settings = await getSettingsMap(
      { adminSettings: adminSettingsRepository },
      { names: ['signupBotChecksEnabled'] }
    );
    return getSettingsValue('signupBotChecksEnabled', settings, true);
  } catch (err) {
    logger.warn('signup bot-check setting read failed; applying stored signals', err);
    return true;
  }
}

const handler = baseApi({ auth: false })
  .use(checkBlockedIP())
  .use(otcCounterLimit({ bucket: 'verify-ip', window: OTC_LIMITS.verify.perIp, subject: ipSubject }))
  .post(async (req, res) => {
    const { email, code, username, pendingToken, acceptedPolicyVersion, ageAttestation } = req.body;
    const parsedInviteCode = z.string().trim().optional().safeParse(req.body.inviteCode);
    if (!parsedInviteCode.success) {
      return res.status(400).json({ error: 'Invalid invite code' });
    }
    const inviteCode = parsedInviteCode.data;

    if (!email || !code) {
      return res.status(400).json({ error: 'Email and code are required' });
    }

    const normalizedEmail = (email as string).toLowerCase().trim();

    // --- UNIFORM CODE VERIFICATION (enumeration-resistant by construction) ---
    // Both login and registration verify the emailed code against the server-side
    // record for the signed pending token issued by /api/otc/send (which returns an
    // identical token and writes an identical record for every address). NOTHING in this block reads account state, so the response
    // never reveals whether an account exists. Account existence only affects what
    // happens AFTER a correct code proves ownership (see "CODE PROVEN" below).
    //
    // Every failure here returns the SAME generic error, so a missing / malformed /
    // expired / replayed token is indistinguishable from a simply-wrong code.
    if (!pendingToken || typeof pendingToken !== 'string') {
      throw new UnprocessableEntityError('Invalid code.');
    }

    let tokenPayload: PendingTokenPayload;
    try {
      // Pin the algorithm to HS256 to prevent algorithm-confusion attacks.
      tokenPayload = jwt.verify(pendingToken, Config.JWT_SECRET, { algorithms: ['HS256'] }) as PendingTokenPayload;
    } catch {
      throw new UnprocessableEntityError('Invalid code.');
    }

    if (tokenPayload.email !== normalizedEmail || !tokenPayload.jti) {
      throw new UnprocessableEntityError('Invalid code.');
    }

    // Per-code attempt cap (tracked inside the token). Uniform message.
    const attempts = tokenPayload.attempts ?? 0;
    if (attempts >= MAX_PENDING_OTC_ATTEMPTS) {
      throw new UnprocessableEntityError('Too many failed attempts. Please request a new code.');
    }

    // Brute-force bound per (address, source) across every token; the per-token attempt cap alone
    // resets with each new code. The unit is reserved atomically before the compare so concurrent
    // guesses cannot overshoot the limit, then refunded unless the guess was wrong against a live
    // token: another source's guesses never spend it (see OTC_VERIFY_EMAIL_BUDGETS) and tokenless
    // junk is bounded per IP.
    const ipBucket = ipSubject(req);
    const budget = await reserveOtcEmailBudget(normalizedEmail, ipBucket, OTC_VERIFY_EMAIL_BUDGETS);
    if ('retryAfter' in budget) {
      res.setHeader('Retry-After', String(budget.retryAfter));
      return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
    }

    // Server-side nonce: single-use + JWT-replay protection. Rotating to a fresh
    // nonce invalidates the presented token (the client must use the re-issued token
    // below to retry). A stale/replayed token, or one whose record holds no code hash,
    // fails this check -> generic invalid. The code hash is only ever read from here.
    const newNonce = randomUUID();
    const pendingCode = await pendingOtcTokenRepository.validateAndRotateNonce(
      normalizedEmail,
      tokenPayload.jti,
      newNonce
    );
    if (!pendingCode) {
      await budget.refund();
      throw new UnprocessableEntityError('Invalid code.');
    }

    const isValid = await userService.verifyPendingOTC(code, pendingCode.otcHash);
    if (!isValid) {
      // Re-issue the token with an incremented attempt count + the rotated nonce so
      // the user can retry. Identical response for existing and non-existent accounts
      // (no existence lookup has happened yet).
      const nextAttempts = attempts + 1;
      const updatedToken = jwt.sign(
        {
          email: tokenPayload.email,
          attempts: nextAttempts,
          jti: newNonce,
          challengeVerified: tokenPayload.challengeVerified === true ? true : null,
        },
        Config.JWT_SECRET,
        { algorithm: 'HS256', expiresIn: Math.max(0, tokenPayload.exp - Math.floor(Date.now() / 1000)) }
      );
      const remaining = MAX_PENDING_OTC_ATTEMPTS - nextAttempts;
      return res.status(422).json({
        error: `Invalid code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`,
        pendingToken: updatedToken,
      });
    }

    // --- CODE PROVEN - only the email owner can reach here. Branch on existence now. ---
    // A correct code costs nothing against the guess budget.
    await budget.refund();
    // Up to MAX_LIVE_OTC_CODES codes stay live per address; a proven one retires the rest.
    // Best-effort like the writes below: the nonce is already rotated, so a failure here must not
    // 500 a proven login. Leftover codes still expire and are capped per address.
    try {
      await pendingOtcTokenRepository.consumeOtherCodes(normalizedEmail, newNonce);
    } catch (err) {
      req.logger.error('OTC login consumeOtherCodes failed', err);
    }
    const existingUser = await userRepository.findByEmail(normalizedEmail);

    if (existingUser) {
      // System accounts never sign in interactively; banned accounts are blocked.
      // These are post-verification (reachable only by the email owner), so they are
      // not enumeration oracles.
      if (existingUser.isSystem) {
        return res.status(403).json({ error: 'This account cannot sign in.' });
      }
      if (existingUser.isBanned) {
        return res.status(403).json({ error: 'This account has been suspended.' });
      }

      // A configured bootstrap admin whose account was created but never promoted (a write failed
      // after creation) is promoted on this sign-in, so the install is not left without an admin.
      if (
        process.env.B4M_SELF_HOST === 'true' &&
        !existingUser.isAdmin &&
        normalizedEmail === configuredBootstrapAdminEmail() &&
        (await userRepository.count({ isAdmin: true })) === 0
      ) {
        try {
          await userRepository.update({ id: existingUser.id, isAdmin: true });
          existingUser.isAdmin = true;
          req.logger.info('Self-host bootstrap: configured admin promoted on sign-in', { userId: existingUser.id });
        } catch (err) {
          // Best-effort like the verified flag below: the nonce is already rotated, and the next sign-in retries.
          req.logger.warn('Self-host bootstrap: sign-in promotion failed', { userId: existingUser.id, err });
        }
      }

      // OTC proves email ownership - mark verified on first successful sign-in.
      // Best-effort: the nonce is already rotated, so a transient write failure on this
      // bookkeeping must not 500 a proven login (the retry would dead-end as "Invalid
      // code."). The flag is re-attempted on every subsequent sign-in anyway.
      if (!existingUser.emailVerified) {
        existingUser.emailVerified = true;
        existingUser.emailVerifiedAt = new Date();
        try {
          // Write only the fields set here: a later loginRecords update below writes the same doc,
          // and a whole-doc write on either would clobber the other's change. The verification-link
          // fields are cleared in the same write: this code just proved the email, so any link still
          // pending on the account is stale, and a later click would re-run the verified-email grants.
          await userRepository.update({
            id: existingUser.id,
            emailVerified: existingUser.emailVerified,
            emailVerifiedAt: existingUser.emailVerifiedAt,
            emailVerificationToken: null,
            emailVerificationExpires: null,
            emailVerificationSentAt: null,
          });
          // The code just proved email ownership, and later logins skip this branch, so this is
          // the account's one chance at what /api/email/verify would have granted. A failed write
          // above skips it, and the next login retries both.
          const grants = await applyEmailVerifiedGrants({
            user: existingUser,
            verifiedEmail: normalizedEmail,
            trigger: 'otc-login-verification',
            releaseReason: 'OTC login (email verified)',
            logger: req.logger,
          });
          if (grants.tags) {
            existingUser.tags = grants.tags;
            existingUser.pendingCreditGrant = null;
          }
          if (grants.tagsApplied.length > 0) {
            existingUser.tags = [...new Set([...(existingUser.tags ?? []), ...grants.tagsApplied])];
          }
          if (grants.currentCredits !== null) existingUser.currentCredits = grants.currentCredits;
          if (grants.joinedOrganizationId) existingUser.organizationId = grants.joinedOrganizationId;
          await emitEmailVerifiedFunnelEvents({
            user: existingUser,
            method: 'otc',
            creditsGranted: grants.creditsGranted + grants.subscriptionCreditsGranted,
          });
        } catch (err) {
          req.logger.error('OTC login emailVerified update failed', err);
        }
      }

      // --- SECOND FACTOR --- (a remembered device skips the challenge, never enrollment)
      const secondFactor = await resolveSecondFactor(req, existingUser, {
        origin: { strategy: 'otc', createdVia: 'otc' },
      });
      if (secondFactor.kind === 'challenge') {
        return res.status(200).json({
          mfaRequired: true,
          passkeyAvailable: secondFactor.passkeyAvailable,
          userId: existingUser.id,
          accessToken: secondFactor.mfaToken,
        });
      }
      if (secondFactor.kind === 'enroll') {
        return res
          .status(200)
          .json({ mfaSetupRequired: true, userId: existingUser.id, accessToken: secondFactor.mfaToken });
      }

      // --- DIRECT LOGIN ---
      const { accessToken, refreshToken } = await authSessionService.issueSession(
        existingUser.id,
        { createdVia: 'otc', tokenVersion: existingUser.tokenVersion ?? 0, device: buildSessionDevice(req) },
        {
          db: { authSessions: authSessionRepository },
          signAccessToken: (id, tv, extra) => authTokenGenerator.signAccessToken(id, tv, extra),
          logger: req.logger,
        }
      );
      setRefreshCookie(res, refreshToken);
      await recordLoginEvent({ req, userId: existingUser.id, method: 'otc' });
      const tokens = { accessToken };
      const ip = getClientIp(req);

      // Analytics + device history are best-effort for the same post-rotation reason as
      // above: the login is already proven, so none of these writes may fail the response.
      // (logSignInSuccess -> logAuthAudit already swallows internally by design.)
      await logEvent({
        userId: existingUser.id,
        type: AuthEvents.LOGIN,
        metadata: { strategy: 'otc', ip, userAgent: req.headers['user-agent'] || 'unknown' },
      }).catch(err => req.logger.error('OTC login analytics log failed', err));
      await logSignInSuccess(req, {
        userId: existingUser.id,
        strategy: 'otc',
        trustedDevice: secondFactor.trustedDevice,
      });

      // Update login records
      const clientData = req.body.clientData;
      if (clientData) {
        existingUser.loginRecords ||= [];
        existingUser.loginRecords.unshift({
          loginTime: new Date(),
          userAgent: clientData.userAgent || req.headers['user-agent'] || 'Unknown',
          browser: clientData.browser || 'Unknown',
          operatingSystem: clientData.operatingSystem || 'Unknown',
          deviceType: clientData.deviceType || 'Desktop',
          screenResolution: clientData.screenResolution || 'Unknown',
          viewportSize: clientData.viewportSize || 'Unknown',
          colorDepth: clientData.colorDepth || 0,
          pixelDepth: clientData.pixelDepth || 0,
          devicePixelRatio: clientData.devicePixelRatio || 1,
          ip: getClientIp(req),
        });
        existingUser.loginRecords = existingUser.loginRecords.slice(0, 15);
        try {
          // Targeted write (see emailVerified update above): only the loginRecords field.
          await userRepository.update({ id: existingUser.id, loginRecords: existingUser.loginRecords });
        } catch (err) {
          req.logger.error('OTC login loginRecords update failed', err);
        }
      }

      // Route through the shared self-view serializer (same as mfa/verify) so the login
      // response carries the same redacted shape as GET /users/[id]. `select:false` alone
      // does not cover every secret field, so serialize at the boundary here too.
      const safeUser = redactUserSecretsForSelf(existingUser);
      return respond(res, otcLoginResponseSchema, { ...safeUser, ...tokens });
    }

    // --- NEW USER REGISTRATION ---
    // Reached only after a correct code, so this is enumeration-safe.
    // A fresh self-host install admits its bootstrap account and promotes it to admin below.
    const isSelfHost = process.env.B4M_SELF_HOST === 'true';
    const bootstrap = resolveBootstrapAdmin({
      isSelfHost,
      userCount: isSelfHost ? await userRepository.count({}) : 0,
      email: normalizedEmail,
      bootstrapEmail: configuredBootstrapAdminEmail(),
    });

    // If no username was supplied, this is a login attempt for an email with no account:
    // signal the client to collect a username and finish registration inline. The code is
    // single-use (the nonce was already rotated above), so hand back a re-issued token
    // carrying the rotated nonce (whose record keeps the same code hash) - this lets the client complete
    // registration in one continuous flow with NO second OTC email (same pattern as the
    // wrong-code re-issue above). Only reachable post-verification, so it leaks nothing.
    if (!username || typeof username !== 'string') {
      const partnerAllowed = !bootstrap.eligible && (await isPartnerDomainSignupAllowed(normalizedEmail, true));
      const registrationToken = jwt.sign(
        {
          email: tokenPayload.email,
          attempts,
          jti: newNonce,
          challengeVerified: tokenPayload.challengeVerified === true ? true : null,
        },
        Config.JWT_SECRET,
        {
          algorithm: 'HS256',
          expiresIn: Math.max(0, tokenPayload.exp - Math.floor(Date.now() / 1000)),
        }
      );
      return res.status(200).json({
        registrationRequired: true,
        registrationAllowed: bootstrap.eligible || partnerAllowed || (await isOpenRegistrationAllowed()),
        email: normalizedEmail,
        pendingToken: registrationToken,
      });
    }

    // Only the claim winner is the bootstrap user; anyone else registers under the normal rules.
    let bootstrapClaimId: string | null = null;
    let domainBudget: Awaited<ReturnType<typeof reserveOtcRegistrationDomainBudget>> | undefined;

    // Register + finalize (email-verified state, deferred free-credit grant) in one
    // service call. registerViaOTC grants credits BEFORE dropping the pending tag, so
    // a grant failure leaves a retry breadcrumb rather than losing credits.
    let newUser: Awaited<ReturnType<typeof userService.registerViaOTC>>;
    try {
      // Inside the try so a claim or lookup failure still re-issues the token (the nonce is spent).
      bootstrapClaimId = bootstrap.eligible ? await claimBootstrapAdmin() : null;
      const partnerDomainAllowed =
        bootstrapClaimId === null && (await isPartnerDomainSignupAllowed(normalizedEmail, true));
      const signupNetwork = readNetworkMeta(req);
      // The network caps are for anonymous self-serve signups; a partner rule or the bootstrap
      // claim is an admin's authorization, as for enterprise SSO.
      if (bootstrapClaimId === null && !partnerDomainAllowed) {
        await assertSignupNetworkWithinLimits(signupNetwork, req.logger);
      }
      // A self-host install's staff all share one fresh domain, and a partner domain is one an
      // admin already vouched for, so neither is capped (see OTC_REGISTER_DOMAIN_BUDGETS).
      domainBudget =
        isSelfHost || partnerDomainAllowed ? undefined : await reserveOtcRegistrationDomainBudget(normalizedEmail);
      if (domainBudget && 'retryAfter' in domainBudget) {
        res.setHeader('Retry-After', String(domainBudget.retryAfter));
        throw new TooManyRequestsError('Too many new accounts on this email domain. Please try again later.');
      }
      const register = () =>
        userService.registerViaOTC(
          {
            username: username.trim(),
            email: normalizedEmail,
            name: username.trim(),
            password: '',
            inviteCode,
            // P0-B abuse gate: registerUser rejects creation unless these are present and
            // current, so a new OTC account is gated at creation just like the credentials path. The
            // client collects both before submitting (register form, or the inline username step).
            acceptedPolicyVersion,
            ageAttestation,
            sourceClientId: parseSourceClientId(req.body.sourceClientId),
            metadata: req.body.clientData
              ? {
                  loginTime: new Date(),
                  userAgent: req.body.clientData.userAgent || 'Unknown',
                  browser: req.body.clientData.browser || 'Unknown',
                  operatingSystem: req.body.clientData.operatingSystem || 'Unknown',
                  deviceType: req.body.clientData.deviceType || 'Desktop',
                  screenResolution: req.body.clientData.screenResolution || 'Unknown',
                  viewportSize: req.body.clientData.viewportSize || 'Unknown',
                  colorDepth: req.body.clientData.colorDepth || 0,
                  pixelDepth: req.body.clientData.pixelDepth || 0,
                  devicePixelRatio: req.body.clientData.devicePixelRatio || 1,
                  ip: getClientIp(req),
                }
              : undefined,
          },
          {
            db: {
              users: userRepository,
              signupProtection,
              adminSettings: adminSettingsRepository,
              registrationInvites: registrationInviteRepository,
              subscribers: subscriberRepository,
              creditTransactions: creditTransactionRepository,
              oauthClients: oauthClientRepository,
              creditLots: creditLotRepository,
            },
            logger: req.logger,
            skipInviteCheck: bootstrapClaimId !== null || partnerDomainAllowed,
            signupMeta: {
              ...signupNetwork,
              capturedAt: new Date(),
              challengeVerified: tokenPayload.challengeVerified === true ? true : null,
            },
            collectRiskSignals: createSignupGrantRiskCollector(signupNetwork),
            emitRiskBand: async band => {
              req.logger.info(`signup-grant-assessed-${band}`);
            },
          }
        );
      // Roll back the losing account when concurrent signups redeem one single-use invite.
      newUser = inviteCode
        ? await userService.refundBudgetOnFailure(() => withTransaction(register, { logger: req.logger }))
        : await register();
    } catch (err) {
      if (bootstrapClaimId) {
        await releaseBootstrapAdminClaim(bootstrapClaimId).catch(releaseErr =>
          req.logger.error('Self-host bootstrap claim release failed', releaseErr)
        );
      }
      if (domainBudget && 'refund' in domainBudget) {
        await domainBudget
          .refund()
          .catch(refundErr => req.logger.error('OTC registration domain budget refund failed', refundErr));
      }
      // Registration failed AFTER the single-use nonce was rotated above, so the token the
      // client is holding can never validate again - without a re-issue every retry dies as a
      // generic "Invalid code." Re-issue with the rotated nonce so the user can fix
      // the problem (e.g. pick another username) and resubmit. The attempt counter increments
      // even though the code was correct: the username is attacker-varying input, and an
      // uncapped re-issue would let one proven code probe username existence indefinitely.
      // Post-code-proven, so the specific error message leaks nothing about email existence.
      // A network-cap refusal is not attacker-varying input, so it does not spend an attempt.
      const nextAttempts = err instanceof TooManyRequestsError ? attempts : attempts + 1;
      const reissuedToken = jwt.sign(
        {
          email: tokenPayload.email,
          attempts: nextAttempts,
          jti: newNonce,
          challengeVerified: tokenPayload.challengeVerified === true ? true : null,
        },
        Config.JWT_SECRET,
        { algorithm: 'HS256', expiresIn: Math.max(0, tokenPayload.exp - Math.floor(Date.now() / 1000)) }
      );
      if (err instanceof HTTPError) {
        err.additionalInfo = { ...err.additionalInfo, pendingToken: reissuedToken };
        throw err;
      }
      // Non-HTTP failure (e.g. transient DB error): still re-issue - the fault wasn't the
      // user's, and if the account was partially created the retry lands on the existing-user
      // login branch and self-heals. Log the real cause; surface only a generic message.
      req.logger.error('OTC inline registration failed', err);
      throw new InternalServerError('Registration failed. Please try again.', { pendingToken: reissuedToken });
    }

    const isBootstrapUser = bootstrapClaimId !== null;

    // Promote the self-host bootstrap account so the instance has an admin from day one.
    if (isBootstrapUser && newUser?.id) {
      if (bootstrap.unconfigured) {
        req.logger.warn(
          `Self-host bootstrap admin email is not configured; set ${BOOTSTRAP_ADMIN_EMAIL_ENV} to choose the first admin. Promoting the first registered user instead.`
        );
      }
      const promoted = await userRepository.update({ id: newUser.id, isAdmin: true });
      if (promoted) newUser = promoted;
      req.logger.info('Self-host bootstrap: first registered user promoted to admin', { userId: newUser.id });
    }

    // Best-effort: a failure here must neither fail the signup nor change the response.
    // Signals are written by otc/send only, from the closed UserRiskSignalType set.
    const signals = (pendingCode.riskSignals ?? []) as UserRiskSignalType[];
    const botChecksEnabled = signals.length > 0 && (await isSignupBotChecksEnabled(req.logger));
    if (signals.length && botChecksEnabled && newUser?.id) {
      const signalLog = { userId: newUser.id, signals };
      let step = 'record risk signals';
      try {
        await userRepository.update({
          id: newUser.id,
          riskSignals: signals.map(type => ({ type, at: new Date() })),
        });
        // Missing or expired form tokens are record-only: the token fetch can be in flight, fail, be rate-limited, or the tab left open.
        // Too-fast alone is record-only too (autofill + Enter can beat the timer); it rides along with a stronger signal.
        const recordOnly: UserRiskSignalType[] = ['signup_token_missing', 'signup_token_expired', 'signup_too_fast'];
        const actionable = signals.filter(s => !recordOnly.includes(s));
        if (actionable.length) {
          step = 'set throttle tier';
          const tierChange = await userService.setThrottleTier(
            newUser.id,
            'shadow',
            { reason: `signup checks: ${signals.join(',')}`, source: throttleSourceForSignal(actionable[0]) },
            { db: { users: userRepository } }
          );
          if (tierChange.changed) {
            step = 'record audit entry';
            await recordAdminActionForActor(req, systemAuditActor('signup-checks'), {
              action: 'user.throttle_tier.changed',
              target: { kind: 'user', id: newUser.id, displayName: normalizedEmail },
              summary: `set the restricted tier to ${tierChange.after} (source: signup checks, signals: ${signals.join(',')})`,
              changes: [{ field: 'throttle.tier', before: tierChange.before, after: tierChange.after }],
            });
          }
        }
      } catch (err) {
        req.logger.error(`OTC signup signal application failed: ${step}`, { ...signalLog, err });
      }
    }

    // registerViaOTC set emailVerified=true, so the now-verified domain may confer its signup
    // grant (one-time domain credits on top of the flat grant, partner-rule org membership and tags).
    // Never throws, so it cannot 500 a completed registration. Reflect the grant and any join on
    // the returned user so the client sees the full balance and the org immediately.
    const domainGrant = await applySignupDomainGrant({
      userId: newUser.id,
      email: normalizedEmail,
      trigger: 'otc-signup',
      logger: req.logger,
    });
    if (domainGrant.currentCredits !== null) newUser.currentCredits = domainGrant.currentCredits;
    if (domainGrant.joinedOrganizationId) newUser.organizationId = domainGrant.joinedOrganizationId;
    if (domainGrant.tagsApplied.length > 0) {
      newUser.tags = [...new Set([...(newUser.tags ?? []), ...domainGrant.tagsApplied])];
    }

    // Analytics only - the account already exists, so a counter-write failure must not 500 a
    // completed registration (post-rotation, that would strand the client on a success).
    await logEvent({
      userId: newUser.id,
      type: AuthEvents.REGISTER,
      metadata: { strategy: 'otc' },
    }).catch(err => req.logger.error('OTC registration analytics log failed', err));
    await recordSignupNetwork({ req, userId: newUser.id, method: 'otc' });
    // After recordSignupNetwork so the datacenter signal sees the stored signup network.
    await refreshSignupRiskScore(newUser.id, req.logger);
    // Funnel floor (server/analytics/funnel.ts): keep the consented touches on the user so later
    // stages stay joinable to the door, then report the stages OTC completes in one step - the
    // code proved the email, and registerViaOTC plus the domain grant above seeded the credits.
    const signupFunnel = await recordSignupAcquisition({ req, user: newUser, method: 'otc' });
    // Credit the signup to the product the visitor came through, if any, and only with consent
    // - see readConsentedAcquisitionTouches. Never throws. Synthetic accounts are detected
    // above so they never reach a signup conversion.
    //
    // Awaited rather than fire-and-forget for the reason the OAuth callback sets out: a signup
    // occurs once per account, so an emit lost to a freeze is lost permanently, and the wait is
    // paid only by the signups that actually name a product.
    if (!signupFunnel.isSynthetic) {
      await emitSignupForSourceProducts({
        userId: newUser.id,
        touches: readConsentedAcquisitionTouches(req),
        method: 'otc',
      });
    }
    const funnelUser = { id: newUser.id, ...signupFunnel };
    await emitFunnelEvent({ user: funnelUser, event: 'email_verified', metadata: { method: 'otc' } });
    await emitFunnelEvent({
      user: funnelUser,
      event: 'credits_granted',
      metadata: { amount: newUser.currentCredits ?? 0, source: 'signup', method: 'otc' },
    });
    await emitFunnelEvent({ user: funnelUser, event: 'signup_completed', metadata: { method: 'otc' } });

    const registrationSession = await authSessionService.issueSession(
      newUser.id,
      { createdVia: 'otc-registration', tokenVersion: newUser.tokenVersion ?? 0, device: buildSessionDevice(req) },
      {
        db: { authSessions: authSessionRepository },
        signAccessToken: (id, tv, extra) => authTokenGenerator.signAccessToken(id, tv, extra),
        logger: req.logger,
      }
    );
    setRefreshCookie(res, registrationSession.refreshToken);
    await recordLoginEvent({ req, userId: newUser.id, method: 'otc-registration' });
    return respond(res, otcRegistrationResponseSchema, {
      user: redactUserSecretsForSelf(newUser),
      accessToken: registrationSession.accessToken,
    });
  });

export default handler;
