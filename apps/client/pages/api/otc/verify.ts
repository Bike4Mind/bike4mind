import {
  AuthEvents,
  CreditHolderType,
  HTTPError,
  InternalServerError,
  UnprocessableEntityError,
} from '@bike4mind/common';
import {
  adminSettingsRepository,
  registrationInviteRepository,
  userRepository,
  subscriberRepository,
  creditTransactionRepository,
  pendingOtcTokenRepository,
} from '@bike4mind/database';
import { creditService, userService } from '@bike4mind/services';
import { entitlementsForEmail, signupCreditsForKeys } from '@client/lib/entitlements/registry';
import { partnerSignupGrantForEmail } from '@server/entitlements/partnerRules';
import { baseApi } from '@server/middlewares/baseApi';
import { checkBlockedIP } from '@server/middlewares/checkBlockedIP';
import { rateLimit } from '@server/middlewares/rateLimit';
import { authTokenGenerator } from '@server/auth/tokenGenerator';
import { Config } from '@server/utils/config';
import { logEvent } from '@server/utils/analyticsLog';
import { logAuthAudit } from '@server/utils/authAudit';
import { mfaService } from '@bike4mind/services';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';

interface PendingTokenPayload {
  email: string;
  otcHash: string;
  attempts: number;
  exp: number;
  jti: string;
}

const MAX_PENDING_OTC_ATTEMPTS = 5;

const handler = baseApi({ auth: false })
  .use(checkBlockedIP())
  .use(
    rateLimit({
      limit: 10,
      windowMs: 15 * 60 * 1000,
    })
  )
  .post(async (req, res) => {
    const { email, code, username, pendingToken, acceptedPolicyVersion, ageAttestation } = req.body;

    if (!email || !code) {
      return res.status(400).json({ error: 'Email and code are required' });
    }

    const normalizedEmail = (email as string).toLowerCase().trim();

    // --- UNIFORM CODE VERIFICATION (enumeration-resistant by construction) ---
    // Both login and registration verify the emailed code against the signed
    // pending token issued by /api/otc/send (which returns an identical token for
    // every address). NOTHING in this block reads account state, so the response
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

    // Server-side nonce: single-use + JWT-replay protection. Rotating to a fresh
    // nonce invalidates the presented token (the client must use the re-issued token
    // below to retry). A stale/replayed token fails this check -> generic invalid.
    const newNonce = randomUUID();
    const nonceValid = await pendingOtcTokenRepository.validateAndRotateNonce(
      normalizedEmail,
      tokenPayload.jti,
      newNonce
    );
    if (!nonceValid) {
      throw new UnprocessableEntityError('Invalid code.');
    }

    const isValid = await userService.verifyPendingOTC(code, tokenPayload.otcHash);
    if (!isValid) {
      // Re-issue the token with an incremented attempt count + the rotated nonce so
      // the user can retry. Identical response for existing and non-existent accounts
      // (no existence lookup has happened yet).
      const nextAttempts = attempts + 1;
      const updatedToken = jwt.sign(
        { email: tokenPayload.email, otcHash: tokenPayload.otcHash, attempts: nextAttempts, jti: newNonce },
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
          await userRepository.update(existingUser);
        } catch (err) {
          req.logger.error('OTC login emailVerified update failed', err);
        }
      }

      // --- MFA LOGIC (same as password login) ---
      const settings = await getSettingsMap({ adminSettings: adminSettingsRepository });
      const enforceMFA = getSettingsValue('enforceMFA', settings) || false;
      const userHasMFA = mfaService.userHasMFAConfigured(existingUser);

      if (userHasMFA || (enforceMFA && !userHasMFA)) {
        // Only issue the short-lived mfaPending access token (no refresh token).
        // /api/auth/mfa/verify mints the full token pair on success. Without this
        // omission, a client could POST the mfaPending refresh token directly to
        // /api/auth/refreshToken (which has no mfaPending check) and get a full
        // session without passing the second factor.
        const mfaAccessToken = jwt.sign(
          { id: existingUser.id, mfaPending: true, tokenVersion: existingUser.tokenVersion ?? 0 },
          Config.JWT_SECRET,
          { algorithm: 'HS256', expiresIn: '10m' }
        );
        return res.status(200).json({
          ...(userHasMFA ? { mfaRequired: true } : { mfaSetupRequired: true }),
          userId: existingUser.id,
          accessToken: mfaAccessToken,
        });
      }

      // --- DIRECT LOGIN ---
      const tokens = authTokenGenerator.createAccessToken(existingUser.id, existingUser.tokenVersion ?? 0);
      const ip = req.socket?.remoteAddress || (req.headers['x-forwarded-for'] as string) || req.ip || 'unknown';

      // Analytics + device history are best-effort for the same post-rotation reason as
      // above: the login is already proven, so none of these writes may fail the response.
      // (logAuthAudit already swallows internally by design.)
      await logEvent({
        userId: existingUser.id,
        type: AuthEvents.LOGIN,
        metadata: { strategy: 'otc', ip, userAgent: req.headers['user-agent'] || 'unknown' },
      }).catch(err => req.logger.error('OTC login analytics log failed', err));
      await logAuthAudit(req, { userId: existingUser.id, event: 'login_success', strategy: 'otc' });

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
          await userRepository.update(existingUser);
        } catch (err) {
          req.logger.error('OTC login loginRecords update failed', err);
        }
      }

      // Serialize via toJSON() (not a raw spread of the Mongoose doc) so the schema's
      // transforms apply and no internal/`select:false` field can slip into the response.
      const safeUser = typeof existingUser.toJSON === 'function' ? existingUser.toJSON() : existingUser;
      return res.status(200).json({ ...safeUser, ...tokens });
    }

    // --- NEW USER REGISTRATION ---
    // Reached only after a correct code, so this is enumeration-safe.
    // If no username was supplied, this is a login attempt for an email with no account:
    // signal the client to collect a username and finish registration inline. The code is
    // single-use (the nonce was already rotated above), so hand back a re-issued token
    // carrying the rotated nonce + same code hash - this lets the client complete
    // registration in one continuous flow with NO second OTC email (same pattern as the
    // wrong-code re-issue above). Only reachable post-verification, so it leaks nothing.
    if (!username || typeof username !== 'string') {
      const registrationToken = jwt.sign(
        { email: tokenPayload.email, otcHash: tokenPayload.otcHash, attempts, jti: newNonce },
        Config.JWT_SECRET,
        { algorithm: 'HS256', expiresIn: Math.max(0, tokenPayload.exp - Math.floor(Date.now() / 1000)) }
      );
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
        { email: tokenPayload.email, otcHash: tokenPayload.otcHash, attempts: nextAttempts, jti: newNonce },
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

    // Domain-grant signup credits (mirrors /api/email/verify Phase 2b). OTC proved email
    // ownership and registerViaOTC set emailVerified=true, so the now-verified domain may
    // confer a one-time signup grant - ADDITIVE on top of the flat defaultFreeCredits
    // registerViaOTC already granted (distinct transactionId). Idempotent via the stable
    // `domain-grant-credits:${userId}` id - the SAME id email/verify uses, so a user who
    // somehow hits both paths is never double-granted.
    //
    // Source precedence (issue #293): a DB-backed PartnerSignupRule wins; the env registry
    // (`entitlementsForEmail` / `signupCreditsForKeys`) is the migration fallback for a domain
    // not yet in the collection. `matched` lets a DB rule grant access with 0 bonus credits
    // without falling through to the env amount.
    //
    // Wrapped whole (resolve + grant) so a failure can't 500 a completed registration: the
    // account exists and the client already holds a token, the same post-rotation invariant as
    // the analytics call below. The stable transactionId makes an admin/maintenance retry safe.
    try {
      const partnerGrant = await partnerSignupGrantForEmail(normalizedEmail, true);
      const signupCredits = partnerGrant.matched
        ? partnerGrant.signupCredits
        : signupCreditsForKeys(entitlementsForEmail(normalizedEmail, true));
      if (signupCredits > 0) {
        const updatedHolder = await creditService.addCredits(
          {
            ownerId: newUser.id,
            ownerType: CreditHolderType.User,
            credits: signupCredits,
            type: 'generic_add',
            transactionId: `domain-grant-credits:${newUser.id}`,
            reason: 'domain-grant signup credits',
          },
          { db: { creditTransactions: creditTransactionRepository }, creditHolderMethods: userRepository }
        );
        // Reflect the grant in the returned user so the client shows the full balance immediately.
        newUser.currentCredits = updatedHolder.currentCredits;
        req.logger.info(
          `Granted ${signupCredits} one-time domain-grant signup credits to OTC-registered user ${newUser.id}`
        );
      }
    } catch (grantError) {
      req.logger.error(
        `OTC registration succeeded for user ${newUser.id} but domain-grant signup-credit grant failed; ` +
          `idempotent transactionId domain-grant-credits:${newUser.id} makes a retry safe`,
        grantError
      );
    }

    // Analytics only - the account already exists, so a counter-write failure must not 500 a
    // completed registration (post-rotation, that would strand the client on a success).
    await logEvent({
      userId: newUser.id,
      type: AuthEvents.REGISTER,
      metadata: { strategy: 'otc' },
    }).catch(err => req.logger.error('OTC registration analytics log failed', err));

    return res.status(200).json({
      user: newUser,
      ...authTokenGenerator.createAccessToken(newUser.id, newUser.tokenVersion ?? 0),
    });
  });

export default handler;
