import type { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import * as z from 'zod';
import type { IUserDocument } from '@bike4mind/common';
import { mfaService } from '@bike4mind/services';
import { userRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { sendFailedMfaAttempt, sendIfLockedOut } from '@server/auth/mfaLockout';
import {
  asPasskeyError,
  sendPasskeyError,
  authenticationResponseSchema,
  getPasskeyRelyingParty,
  passkeyDeps,
} from '@server/auth/passkey';
import {
  markStepUp,
  STEP_UP_FAILED_CODE,
  stepUpMethodsFor,
  stepUpUnavailableError,
  type StepUpMethod,
} from '@server/auth/stepUp';
import { verifyStepUpEmailCode } from '@server/auth/stepUpEmail';
import { logAuthAudit } from '@server/utils/authAudit';
import { NotFoundError } from '@server/utils/errors';

const bodySchema = z.discriminatedUnion('method', [
  z.object({
    method: z.literal('totp'),
    // TOTP code or backup code, same format the sign-in verify accepts.
    code: z
      .string()
      .trim()
      .regex(/^[A-Z0-9]{6,10}$/i, 'Invalid code format.'),
  }),
  z.object({ method: z.literal('passkey'), response: authenticationResponseSchema }),
  z.object({ method: z.literal('password'), password: z.string().min(1).max(1024) }),
  z.object({
    method: z.literal('email'),
    pendingToken: z.string().min(1).max(256),
    code: z
      .string()
      .trim()
      .regex(/^\d{6,10}$/, 'Invalid code format.'),
  }),
]);
type StepUpBody = z.infer<typeof bodySchema>;

const audit = (req: Request, userId: string, method: StepUpMethod, success: boolean) =>
  logAuthAudit(req, { userId, event: success ? 'step_up_success' : 'step_up_failed', metadata: { method } });

/**
 * A rejected proof answers 400, never 401: the client's HTTP layer treats a 401 as an expired
 * access token and would refresh and replay the same proof (see app/contexts/ApiContext.tsx).
 */
const sendStepUpFailed = (res: Response, body: { error: string; attemptsRemaining?: number }) =>
  res.status(400).json({ ...body, code: STEP_UP_FAILED_CODE });

async function succeed(req: Request, res: Response, method: StepUpMethod, stepUpUntil: Date | null) {
  if (!stepUpUntil) throw stepUpUnavailableError();
  await audit(req, req.user.id, method, true);
  return res.json({ stepUpUntil: stepUpUntil.toISOString() });
}

/** Re-checks the second factor with the MFA lockout shared with sign-in. */
async function verifyFactor(req: Request, res: Response, body: Extract<StepUpBody, { method: 'totp' | 'passkey' }>) {
  // Loaded with the select:false MFA secrets: both success paths rewrite the `mfa` subdocument.
  const user = await userRepository.findByIdWithMfaSecrets(req.user.id);
  if (!user) throw new NotFoundError('User not found');
  if (sendIfLockedOut(res, user)) return;

  try {
    if (body.method === 'totp') {
      await mfaService.verifyMFA({ user, token: body.code }, userRepository);
    } else {
      await mfaService.finishPasskeyAuthentication(
        { user, rp: getPasskeyRelyingParty(), response: body.response as mfaService.AuthenticationResponseJSON },
        { ...passkeyDeps, users: userRepository }
      );
    }
  } catch (error) {
    // Like sign-in verify, any rejected TOTP/backup code counts toward the lockout.
    if (body.method === 'passkey') {
      const passkeyError = asPasskeyError(error);
      if (!passkeyError) throw error;
      // As at sign-in, only a presented-but-rejected credential counts toward the lockout.
      if (passkeyError.code !== 'verification_failed' && passkeyError.code !== 'unknown_credential') {
        return sendPasskeyError(res, error);
      }
    }
    await audit(req, user.id, body.method, false);
    return sendFailedMfaAttempt(res, user.id, { error: 'Verification failed.', code: STEP_UP_FAILED_CODE });
  }

  return succeed(req, res, body.method, await markStepUp(req.user));
}

/**
 * Re-prove identity so this session may make sensitive account changes for STEP_UP_WINDOW_MS
 * (see server/auth/stepUp.ts). Which proofs are accepted is decided per user by stepUpMethodsFor.
 */
const handler = baseApi({ auth: 'jwtOnly' })
  .use(rateLimit({ limit: 10, windowMs: 15 * 60 * 1000, bucket: '/api/auth/step-up' }))
  .post(async (req, res) => {
    const body = bodySchema.parse(req.body);
    const sid = req.user.sid;
    if (!sid) throw stepUpUnavailableError();

    const user: IUserDocument | null = await userRepository.findByIdWithPassword(req.user.id);
    if (!user) throw new NotFoundError('User not found');
    if (!(await stepUpMethodsFor(user)).includes(body.method)) {
      return res.status(400).json({ error: 'This verification method is not available for your account.' });
    }

    switch (body.method) {
      case 'totp':
      case 'passkey':
        return verifyFactor(req, res, body);

      case 'password': {
        if (!user.password || !(await bcrypt.compare(body.password, user.password))) {
          await audit(req, user.id, 'password', false);
          return sendStepUpFailed(res, { error: 'Incorrect password.' });
        }
        return succeed(req, res, 'password', await markStepUp(req.user));
      }

      case 'email': {
        const result = await verifyStepUpEmailCode({
          sid,
          userId: user.id,
          pendingToken: body.pendingToken,
          code: body.code,
        });
        if (!result.ok) {
          await audit(req, user.id, 'email', false);
          return result.reason === 'expired'
            ? sendStepUpFailed(res, { error: 'This code has expired. Request a new one.', attemptsRemaining: 0 })
            : sendStepUpFailed(res, { error: 'Invalid code.', attemptsRemaining: result.attemptsRemaining });
        }
        return succeed(req, res, 'email', result.stepUpUntil);
      }
    }
  });

export default handler;
