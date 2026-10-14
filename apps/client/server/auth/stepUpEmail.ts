import { createHash, randomBytes, randomInt, timingSafeEqual } from 'crypto';
import bcrypt from 'bcryptjs';
import { authSessionRepository } from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { EmailEvents } from '@server/utils/eventBus';
import { buildEmailLogoImg } from '@server/utils/mailer/emailHelpers';
import { STEP_UP_WINDOW_MS } from './stepUp';

/** Wrong codes allowed per emailed step-up challenge before it must be re-sent. */
export const STEP_UP_EMAIL_MAX_ATTEMPTS = 5;

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

function stepUpEmailBody(code: string): string {
  const brand = process.env.APP_NAME || '';
  return `
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
      ${buildEmailLogoImg(brand)}
      <h2>Your verification code</h2>
      <p>Use this code to confirm a change to your account security settings. It expires in 10 minutes.</p>
      <div class="code">${code}</div>
      <p>If you did not try to change your account settings, change your password and sign out of your other sessions.</p>
    </div>
  </body>
</html>`;
}

/**
 * Email a step-up code to `email` and bind it to this session. The returned pending token is an
 * opaque handle; the code hash lives on the AuthSession, never in the shared sign-in code store,
 * so a sign-in code cannot satisfy step-up and a step-up code cannot sign anyone in.
 * The challenge is stored before the email goes out; returns null (nothing sent) when the
 * session is gone.
 */
export async function sendStepUpEmailCode(params: {
  sid: string;
  userId: string;
  email: string;
}): Promise<{ pendingToken: string } | null> {
  const session = await authSessionRepository.findBySid(params.sid);
  if (!session || session.userId !== params.userId || session.revokedAt) return null;

  const pendingToken = randomBytes(32).toString('base64url');
  const code = String(randomInt(0, 10 ** userService.OTC_CODE_LENGTH)).padStart(userService.OTC_CODE_LENGTH, '0');
  const stored = await authSessionRepository.setStepUpEmailChallenge(params.sid, params.userId, {
    tokenHash: hashToken(pendingToken),
    codeHash: await bcrypt.hash(code, 10),
    expiresAt: new Date(Date.now() + userService.OTC_EXPIRY_MS),
  });
  if (!stored) return null;

  await EmailEvents.Send.publish({ to: params.email, subject: 'Your verification code', body: stepUpEmailBody(code) });
  return { pendingToken };
}

export type StepUpEmailResult =
  | { ok: true; stepUpUntil: Date }
  | { ok: false; reason: 'expired' }
  | { ok: false; reason: 'invalid'; attemptsRemaining: number };

/** Check an emailed step-up code and, when it matches, consume it and stamp the session. */
export async function verifyStepUpEmailCode(params: {
  sid: string;
  userId: string;
  pendingToken: string;
  code: string;
}): Promise<StepUpEmailResult> {
  const challenge = await authSessionRepository.findStepUpEmailChallenge(params.sid, params.userId);
  const tokenHash = hashToken(params.pendingToken);
  if (
    !challenge ||
    !timingSafeEqual(Buffer.from(challenge.tokenHash), Buffer.from(tokenHash)) ||
    challenge.attempts >= STEP_UP_EMAIL_MAX_ATTEMPTS
  ) {
    return { ok: false, reason: 'expired' };
  }

  if (!(await bcrypt.compare(params.code, challenge.codeHash))) {
    const attempts = await authSessionRepository.recordStepUpEmailChallengeFailure(params.sid, tokenHash);
    return {
      ok: false,
      reason: 'invalid',
      attemptsRemaining: Math.max(0, STEP_UP_EMAIL_MAX_ATTEMPTS - (attempts ?? STEP_UP_EMAIL_MAX_ATTEMPTS)),
    };
  }

  const now = new Date();
  const session = await authSessionRepository.consumeStepUpEmailChallenge(
    params.sid,
    params.userId,
    tokenHash,
    now,
    STEP_UP_EMAIL_MAX_ATTEMPTS
  );
  return session
    ? { ok: true, stepUpUntil: new Date(now.getTime() + STEP_UP_WINDOW_MS) }
    : { ok: false, reason: 'expired' };
}
