import { pendingOtcTokenRepository } from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { baseApi } from '@server/middlewares/baseApi';
import { checkBlockedIP } from '@server/middlewares/checkBlockedIP';
import {
  OTC_LIMITS,
  OTC_SEND_EMAIL_BUDGETS,
  ipSubject,
  otcCounterLimit,
  otcDistinctEmailsPerIpLimit,
  otcEmailBudgetRetryAfter,
  reserveOtcEmailBudget,
} from '@server/utils/otcLimits';
import { EmailEvents } from '@server/utils/eventBus';
import { getLogoUrl } from '@server/utils/mailer/emailHelpers';
import { Config, isE2EEnabled } from '@server/utils/config';
import jwt from 'jsonwebtoken';

const handler = baseApi({ auth: false })
  .use(checkBlockedIP())
  .use(otcCounterLimit({ bucket: 'send-ip-daily', ...OTC_LIMITS.send.perIpDaily, subject: ipSubject }))
  .use(otcCounterLimit({ bucket: 'send-ip-total', ...OTC_LIMITS.send.perIpTotal, subject: ipSubject }))
  .use(otcDistinctEmailsPerIpLimit())
  .post(async (req, res) => {
    const { email } = req.body;

    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Normalize at the boundary so the service never sees raw user input.
    const normalizedEmail = email.toLowerCase().trim();

    // Validate format after normalization to avoid Zod 422 leaking schema details.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }

    const ipBucket = ipSubject(req);
    // Per-email budgets are only spent once a code is about to be dispatched (see
    // OTC_SEND_EMAIL_BUDGETS), so refused requests cannot exhaust the owner's allowance. This read
    // refuses an over-budget caller before it can touch the address's cooldown below.
    const budgetRetryAfter = await otcEmailBudgetRetryAfter(normalizedEmail, ipBucket, OTC_SEND_EMAIL_BUDGETS);
    if (budgetRetryAfter !== undefined) {
      res.setHeader('Retry-After', String(budgetRetryAfter));
      return res.status(429).json({ error: 'Please wait before requesting another code.' });
    }

    // Atomic per-recipient cooldown (keyed on PendingOtcToken, written for every send, so it never reveals whether an account exists).
    // tryReserveSlot atomically claims a reservation slot for this email; if the
    // cooldown is still active, or a concurrent request already claimed it, it
    // returns allowed:false. This replaces the previous check-then-act (non-atomic)
    // pattern that allowed N concurrent requests to all read "no record" and all
    // send an email. E2E (non-prod only) collapses the cooldown to 0 so repeated
    // sends to the same address within a run never 429 on cooldown alone - the
    // reservation is confirmed below with confirmReservation, which still detects
    // (and rejects) a genuinely concurrent resend that would otherwise clobber
    // this one's nonce.
    const cooldownMs = isE2EEnabled() ? 0 : OTC_LIMITS.send.cooldownMs;
    const reservation = await pendingOtcTokenRepository.tryReserveSlot(normalizedEmail, cooldownMs);
    if (!reservation.allowed) {
      res.setHeader('Retry-After', String(reservation.retryAfterSeconds));
      return res.status(429).json({ error: 'Please wait before requesting another code.' });
    }

    // The reservation is keyed on the exact address and the budgets on the folded inbox, so concurrent
    // sends to aliases of one inbox can all pass the read above; this atomic spend is the real bound.
    const budget = await reserveOtcEmailBudget(normalizedEmail, ipBucket, OTC_SEND_EMAIL_BUDGETS);
    if ('retryAfter' in budget) {
      // No code goes out, so hand the cooldown slot back rather than start one for the owner.
      await pendingOtcTokenRepository.releaseReservation(
        normalizedEmail,
        reservation.reservedAt,
        reservation.previousCreatedAt
      );
      res.setHeader('Retry-After', String(budget.retryAfter));
      return res.status(429).json({ error: 'Please wait before requesting another code.' });
    }

    const result = await userService
      .sendOTC(
        { email: normalizedEmail },
        {
          mailer: {
            sendOTCEmail: async (toEmail: string, code: string) => {
              const logoUrl = getLogoUrl();
              const emailBody = `
<!DOCTYPE html>
<html>
  <head>
    <style>
      body { font-family: Arial, sans-serif; line-height: 1.5; color: #333333; }
      .content { margin: 20px; }
      .logo { display: block; margin-bottom: 20px; }
      .code { font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #1a82e2; padding: 16px 24px; background: #f5f5f5; border-radius: 8px; display: inline-block; margin: 16px 0; }
    </style>
  </head>
  <body>
    <div class="content">
      ${logoUrl ? `<img src="${logoUrl}" alt="Logo" class="logo" />` : ''}
      <h2>Your sign-in code</h2>
      <p>Use this code to sign in. It expires in 10 minutes.</p>
      <div class="code">${code}</div>
      <p>If you didn't request this code, you can safely ignore this email.</p>
    </div>
  </body>
</html>`;
              await EmailEvents.Send.publish({
                to: toEmail,
                subject: 'Your sign-in code',
                body: emailBody,
              });
            },
          },
          signPendingToken: payload => {
            return jwt.sign(payload, Config.JWT_SECRET, { algorithm: 'HS256' });
          },
        }
      )
      .catch(async (err: unknown) => {
        await budget.refund();
        throw err;
      });

    // Store the nonce server-side so the verify endpoint can reject replayed tokens.
    // On non-production stages only (isE2EEnabled - hard-false on production), also persist
    // the plaintext code so the test-only /api/test/otc-code endpoint can hand it to
    // Playwright. Production never stores it - only the bcrypt hash lives (in the JWT).
    if (result.nonce) {
      const debugCode = isE2EEnabled() ? result.code : undefined;
      const confirmed = await pendingOtcTokenRepository.confirmReservation(
        normalizedEmail,
        reservation.reservedAt,
        result.nonce,
        debugCode
      );
      if (!confirmed) {
        // A newer concurrent request for this email superseded our reservation before
        // we could persist our nonce - the token we'd return here could never verify,
        // so tell the caller to retry instead of lying that it succeeded.
        res.setHeader('Retry-After', '0');
        return res.status(429).json({ error: 'Please wait before requesting another code.' });
      }
    }

    // Uniform response - never reveals whether user exists
    return res.status(200).json({
      pendingToken: result.pendingToken,
    });
  });

export default handler;
