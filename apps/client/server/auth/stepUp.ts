import type { Request, RequestHandler } from 'express';
import { ForbiddenError, type IUserDocument } from '@bike4mind/common';
import { mfaService } from '@bike4mind/services';
import { authSessionRepository, passkeyCredentialRepository } from '@bike4mind/database';

/**
 * Recent verification ("step-up") for sensitive account changes. A session re-proves the user's
 * identity once (POST /api/auth/step-up) and may then make sensitive changes for this window.
 * The stamp lives on the AuthSession (keyed by the `sid` claim), so a request without a session
 * id - API key, legacy token - can never satisfy it.
 */
export const STEP_UP_WINDOW_MS = 5 * 60 * 1000;

/** Error `code` a gated route returns; the client's HTTP layer keys its verification prompt on it. */
export const STEP_UP_REQUIRED_CODE = 'step_up_required';

export const STEP_UP_METHODS = ['totp', 'passkey', 'password', 'email'] as const;
export type StepUpMethod = (typeof STEP_UP_METHODS)[number];

type StepUpUser = Pick<IUserDocument, 'id'> & { sid?: string };

export const stepUpRequiredError = () =>
  new ForbiddenError('Recent verification required', { code: STEP_UP_REQUIRED_CODE });

/** For a request whose session cannot hold a step-up (no `sid`): signing in again fixes it. */
export const stepUpUnavailableError = () =>
  new ForbiddenError('Verification is not available for this session. Please sign in again.', {
    code: 'step_up_unavailable',
  });

/** End of the current step-up window for this request's session, or null when not stepped up. */
export async function getStepUpUntil(user: StepUpUser, now = new Date()): Promise<Date | null> {
  if (!user.sid) return null;
  const session = await authSessionRepository.findBySid(user.sid);
  if (!session || session.userId !== user.id || session.revokedAt || session.expiresAt <= now) return null;
  if (!session.stepUpAt) return null;
  const until = new Date(new Date(session.stepUpAt).getTime() + STEP_UP_WINDOW_MS);
  return until > now ? until : null;
}

/** Throws the 403 `step_up_required` error unless this session verified within the window. */
export async function requireStepUp(req: Pick<Request, 'user'>): Promise<void> {
  if (!req.user || !(await getStepUpUntil(req.user))) throw stepUpRequiredError();
}

/**
 * Middleware form of requireStepUp. Mount it ahead of a route's own rate limit so a request
 * that is only bounced for verification does not spend the caller's allowance.
 */
export const stepUpGate =
  (options: { skip?: (req: Request) => boolean } = {}): RequestHandler =>
  async (req, _res, next) => {
    try {
      if (!options.skip?.(req)) await requireStepUp(req);
      next();
    } catch (error) {
      next(error);
    }
  };

/** Stamp this session as stepped up now; returns the window's end, or null if the session is gone. */
export async function markStepUp(user: StepUpUser, now = new Date()): Promise<Date | null> {
  if (!user.sid) return null;
  const session = await authSessionRepository.markStepUp(user.sid, user.id, now);
  return session ? new Date(now.getTime() + STEP_UP_WINDOW_MS) : null;
}

/**
 * The proofs this user may step up with. A user with MFA must use their factor (code or passkey):
 * accepting the password or an emailed code instead would make the factor optional for the very
 * changes it protects. `user` must be loaded with its password (findByIdWithPassword).
 */
export async function stepUpMethodsFor(user: IUserDocument): Promise<StepUpMethod[]> {
  const methods: StepUpMethod[] = [];
  if (mfaService.userHasMFAConfigured(user)) {
    methods.push('totp');
    if ((await passkeyCredentialRepository.countByUser(user.id)) > 0) methods.push('passkey');
    return methods;
  }
  if (user.password) methods.push('password');
  if (user.email) methods.push('email');
  return methods;
}
