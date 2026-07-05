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
      limit: 5,
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
    // tryReserveSlot atomically upserts a timestamp-gated placeholder; if a recent
    // record already exists the upsert hits the unique-email index (E11000) and returns
    // allowed:false. This replaces the previous check-then-act (non-atomic) pattern that
    // allowed N concurrent requests to all read "no record" and all send an email.
    const cooldownCheck = await pendingOtcTokenRepository.tryReserveSlot(normalizedEmail, OTC_SEND_COOLDOWN_MS);
    if (!cooldownCheck.allowed) {
      res.setHeader('Retry-After', String(cooldownCheck.retryAfterSeconds ?? 0));
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
      await pendingOtcTokenRepository.storeNonce(normalizedEmail, result.nonce, debugCode);
    }

    // Uniform response - never reveals whether user exists
    return res.status(200).json({
      pendingToken: result.pendingToken,
    });
  });

export default handler;
