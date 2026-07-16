import { pendingOtcTokenRepository } from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { baseApi } from '@server/middlewares/baseApi';
import { checkBlockedIP } from '@server/middlewares/checkBlockedIP';
import { rateLimit } from '@server/middlewares/rateLimit';
import { EmailEvents } from '@server/utils/eventBus';
import { getLogoUrl } from '@server/utils/mailer/emailHelpers';
import { Config, isE2EEnabled } from '@server/utils/config';
import jwt from 'jsonwebtoken';

/**
 * Minimum time between OTC emails to the same recipient. The per-IP rate limit
 * below caps a single IP, but without a per-recipient cap a rotating-IP botnet
 * could spam any inbox with sign-in codes. This cooldown is keyed on the
 * PendingOtcToken record (written for every /send regardless of account
 * existence), so it throttles uniformly and never reveals whether an account exists.
 */
const OTC_SEND_COOLDOWN_MS = 30 * 1000;

const handler = baseApi({ auth: false })
  .use(checkBlockedIP())
  .use(
    rateLimit({
      // E2E (non-prod only - isE2EEnabled is hard-false on production) draws all sends
      // from a single shared CI IP, so the per-IP cap is lifted there to let every
      // OTC-requesting spec run to completion instead of racing a 429.
      limit: () => (isE2EEnabled() ? Infinity : 5),
      windowMs: 15 * 60 * 1000, // 5 sends per 15 min per IP
    })
  )
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

    // Atomic per-recipient cooldown (enumeration-safe - see OTC_SEND_COOLDOWN_MS).
    // tryReserveSlot atomically claims a reservation slot for this email; if the
    // cooldown is still active, or a concurrent request already claimed it, it
    // returns allowed:false. This replaces the previous check-then-act (non-atomic)
    // pattern that allowed N concurrent requests to all read "no record" and all
    // send an email. E2E (non-prod only) collapses the cooldown to 0 so repeated
    // sends to the same address within a run never 429 on cooldown alone - the
    // reservation is confirmed below with confirmReservation, which still detects
    // (and rejects) a genuinely concurrent resend that would otherwise clobber
    // this one's nonce.
    const cooldownMs = isE2EEnabled() ? 0 : OTC_SEND_COOLDOWN_MS;
    const reservation = await pendingOtcTokenRepository.tryReserveSlot(normalizedEmail, cooldownMs);
    if (!reservation.allowed) {
      res.setHeader('Retry-After', String(reservation.retryAfterSeconds));
      return res.status(429).json({ error: 'Please wait before requesting another code.' });
    }

    const result = await userService.sendOTC(
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
    );

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
