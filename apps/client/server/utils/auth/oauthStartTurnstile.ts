import type { Request, RequestHandler } from 'express';
import { TURNSTILE_ACTION_OAUTH_START, TURNSTILE_OAUTH_TOKEN_PARAM, isTurnstileOAuthProvider } from '@bike4mind/common';
import { requireTurnstile } from '@server/middlewares/requireTurnstile';
import type { LoginErrorCode } from '@client/app/utils/loginErrorMessages';

const strategyOf = (req: Request): unknown => req.query?.strategy;

/**
 * The OAuth start route is a plain browser navigation, so the token rides in the query string
 * and a failure lands on the login page as a `?error=` code it already knows how to show,
 * mirroring the callback. Enterprise SSO strategies pass through unchallenged.
 */
export const requireOAuthStartTurnstile = (): RequestHandler =>
  requireTurnstile(TURNSTILE_ACTION_OAUTH_START, {
    token: req => req.query?.[TURNSTILE_OAUTH_TOKEN_PARAM],
    exempt: req => !isTurnstileOAuthProvider(strategyOf(req)),
    onFailure: (_req, res, failure) => {
      const code: LoginErrorCode = failure.code;
      res.redirect(`/login?error=${code}`);
    },
  });
