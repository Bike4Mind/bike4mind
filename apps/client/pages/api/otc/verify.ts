import {
  AuthEvents,
  HTTPError,
  InternalServerError,
  UnprocessableEntityError,
  isOAuthClientIdShape,
  redactUserSecretsForSelf,
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
import { applySignupDomainGrant } from '@server/entitlements/signupDomainGrant';
import { baseApi } from '@server/middlewares/baseApi';
import { checkBlockedIP } from '@server/middlewares/checkBlockedIP';
import {
  OTC_LIMITS,
  OTC_VERIFY_EMAIL_BUDGETS,
  ipSubject,
  otcCounterLimit,
  reserveOtcEmailBudget,
} from '@server/utils/otcLimits';
import { authTokenGenerator } from '@server/auth/tokenGenerator';
import { logSignInSuccess, resolveSecondFactor } from '@server/auth/signInSecondFactor';
import { setRefreshCookie } from '@server/auth/refreshCookie';
import { buildSessionDevice } from '@server/auth/sessionDevice';
import { Config } from '@server/utils/config';
import { logEvent } from '@server/utils/analyticsLog';
import { readConsentedAcquisitionTouches } from '@server/analytics/acquisition';
import { emitSignupForSourceProducts } from '@server/analytics/signupEvents';
import { emitFunnelEvent, recordSignupAcquisition } from '@server/analytics/funnel';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import * as z from 'zod';
import { selfUserResponseSchema } from '@bike4mind/common';
import { respond } from '@server/utils/respond';

interface PendingTokenPayload {
  email: string;
  attempts: number;
  exp: number;
  jti: string;
}

const MAX_PENDING_OTC_ATTEMPTS = 5;

// Attribution only: a malformed value is dropped rather than rejected so it can never fail a signup.
function parseSourceClientId(value: unknown): string | undefined {
  return isOAuthClientIdShape(value) ? value : undefined;
}

// Existing-user login spreads the self-view user at the top level next to the access token.
const otcLoginResponseSchema = selfUserResponseSchema.extend({ accessToken: z.string() });
const otcRegistrationResponseSchema = z.object({ user: selfUserResponseSchema, accessToken: z.string() });

const handler = baseApi({ auth: false })
  .use(checkBlockedIP())
  .use(otcCounterLimit({ bucket: 'verify-ip', ...OTC_LIMITS.verify.perIp, subject: ipSubject }))
  .post(async (req, res) => {
    const { email, code, username, pendingToken, acceptedPolicyVersion, ageAttestation } = req.body;

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
    const otcHash = await pendingOtcTokenRepository.validateAndRotateNonce(normalizedEmail, tokenPayload.jti, newNonce);
    if (!otcHash) {
      await budget.refund();
      throw new UnprocessableEntityError('Invalid code.');
    }

    const isValid = await userService.verifyPendingOTC(code, otcHash);
    if (!isValid) {
      // Re-issue the token with an incremented attempt count + the rotated nonce so
      // the user can retry. Identical response for existing and non-existent accounts
      // (no existence lookup has happened yet).
      const nextAttempts = attempts + 1;
      const updatedToken = jwt.sign(
        { email: tokenPayload.email, attempts: nextAttempts, jti: newNonce },
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

      // OTC proves email ownership - mark verified on first successful sign-in.
      // Best-effort: the nonce is already rotated, so a transient write failure on this
      // bookkeeping must not 500 a proven login (the retry would dead-end as "Invalid
      // code."). The flag is re-attempted on every subsequent sign-in anyway.
      if (!existingUser.emailVerified) {
        existingUser.emailVerified = true;
        existingUser.emailVerifiedAt = new Date();
        try {
          // A tagged account was registered with credits deferred until email ownership is
          // proven; the code just proved it. Never throws. A failed grant keeps the tag, but
          // emailVerified is persisted in this same write, so later logins skip this branch:
          // the only retry is the backfillPendingFreeCredits script.
          const release = await userService.releasePendingFreeCredits(existingUser, {
            db: {
              adminSettings: adminSettingsRepository,
              creditTransactions: creditTransactionRepository,
              creditLots: creditLotRepository,
              users: userRepository,
            },
            reason: 'OTC login (email verified)',
            logger: req.logger,
          });
          // Write only the fields set here: a later loginRecords update below writes the same doc,
          // and a whole-doc write on either would clobber the other's change. The release patch
          // rides this same write so there is no extra round trip.
          await userRepository.update({
            id: existingUser.id,
            emailVerified: existingUser.emailVerified,
            emailVerifiedAt: existingUser.emailVerifiedAt,
            ...release.patch,
          });
          if (release.released) {
            existingUser.tags = release.patch.tags ?? existingUser.tags;
            existingUser.pendingCreditGrant = null;
            if (release.currentCredits !== null) existingUser.currentCredits = release.currentCredits;
          }
        } catch (err) {
          req.logger.error('OTC login emailVerified update failed', err);
        }
      }

      // --- SECOND FACTOR --- (a remembered device skips the challenge, never enrollment)
      const secondFactor = await resolveSecondFactor(req, existingUser);
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
      const tokens = { accessToken };
      const ip = req.socket?.remoteAddress || (req.headers['x-forwarded-for'] as string) || req.ip || 'unknown';

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
          ip: req.ip || '',
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
    // If no username was supplied, this is a login attempt for an email with no account:
    // signal the client to collect a username and finish registration inline. The code is
    // single-use (the nonce was already rotated above), so hand back a re-issued token
    // carrying the rotated nonce (whose record keeps the same code hash) - this lets the client complete
    // registration in one continuous flow with NO second OTC email (same pattern as the
    // wrong-code re-issue above). Only reachable post-verification, so it leaks nothing.
    if (!username || typeof username !== 'string') {
      const registrationToken = jwt.sign({ email: tokenPayload.email, attempts, jti: newNonce }, Config.JWT_SECRET, {
        algorithm: 'HS256',
        expiresIn: Math.max(0, tokenPayload.exp - Math.floor(Date.now() / 1000)),
      });
      return res.status(200).json({
        registrationRequired: true,
        email: normalizedEmail,
        pendingToken: registrationToken,
      });
    }

    // Self-host bootstrap: a fresh install has no admin to issue invites or enable
    // open registration, so the first account skips the invite gate and gets admin.
    const isBootstrapUser = process.env.B4M_SELF_HOST === 'true' && (await userRepository.count({})) === 0;

    // Register + finalize (email-verified state, deferred free-credit grant) in one
    // service call. registerViaOTC grants credits BEFORE dropping the pending tag, so
    // a grant failure leaves a retry breadcrumb rather than losing credits.
    let newUser: Awaited<ReturnType<typeof userService.registerViaOTC>>;
    try {
      newUser = await userService.registerViaOTC(
        {
          username: username.trim(),
          email: normalizedEmail,
          name: username.trim(),
          password: '',
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
                ip: req.ip || '',
              }
            : undefined,
        },
        {
          db: {
            users: userRepository,
            adminSettings: adminSettingsRepository,
            registrationInvites: registrationInviteRepository,
            subscribers: subscriberRepository,
            creditTransactions: creditTransactionRepository,
            oauthClients: oauthClientRepository,
            creditLots: creditLotRepository,
          },
          logger: req.logger,
          skipInviteCheck: isBootstrapUser,
        }
      );
    } catch (err) {
      // Registration failed AFTER the single-use nonce was rotated above, so the token the
      // client is holding can never validate again - without a re-issue every retry dies as a
      // generic "Invalid code." Re-issue with the rotated nonce so the user can fix
      // the problem (e.g. pick another username) and resubmit. The attempt counter increments
      // even though the code was correct: the username is attacker-varying input, and an
      // uncapped re-issue would let one proven code probe username existence indefinitely.
      // Post-code-proven, so the specific error message leaks nothing about email existence.
      const nextAttempts = attempts + 1;
      const reissuedToken = jwt.sign(
        { email: tokenPayload.email, attempts: nextAttempts, jti: newNonce },
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

    // Promote the self-host bootstrap account so the instance has an admin from day one.
    if (isBootstrapUser && newUser?.id) {
      const promoted = await userRepository.update({ id: newUser.id, isAdmin: true });
      if (promoted) newUser = promoted;
      req.logger.info('Self-host bootstrap: first registered user promoted to admin', { userId: newUser.id });
    }

    // registerViaOTC set emailVerified=true, so the now-verified domain may confer its signup
    // grant (one-time domain credits on top of the flat grant, partner-rule org membership).
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

    // Analytics only - the account already exists, so a counter-write failure must not 500 a
    // completed registration (post-rotation, that would strand the client on a success).
    await logEvent({
      userId: newUser.id,
      type: AuthEvents.REGISTER,
      metadata: { strategy: 'otc' },
    }).catch(err => req.logger.error('OTC registration analytics log failed', err));
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
    if ((newUser.currentCredits ?? 0) > 0) {
      await emitFunnelEvent({
        user: funnelUser,
        event: 'credits_granted',
        metadata: { amount: newUser.currentCredits, source: 'signup', method: 'otc' },
      });
    }

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
    return respond(res, otcRegistrationResponseSchema, {
      user: redactUserSecretsForSelf(newUser),
      accessToken: registrationSession.accessToken,
    });
  });

export default handler;
