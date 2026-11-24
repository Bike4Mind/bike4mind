import type { Request, RequestHandler, Response } from 'express';
import {
  SKILL_TEMPLATE_SLUG_MAX,
  SKILL_TEMPLATE_SLUG_PATTERN,
  TURNSTILE_ACTION_SKILL_FREE_RUN,
  skillTemplateFreeRunEligibility,
} from '@bike4mind/common';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { baseApi } from '@server/middlewares/baseApi';
import { checkBlockedIP } from '@server/middlewares/checkBlockedIP';
import { checkTurnstileToken } from '@server/middlewares/requireTurnstile';
import { approvedSnapshotOf } from '@server/skillMarket/template';
import {
  buildFreeRunMessages,
  completeFreeRun,
  FreeRunTimeoutError,
  freeRunCookieHeader,
  hasUsedFreeRun,
  loadFreeRunSettings,
  recordTemplateFreeRun,
  renderFreeRunResult,
  reserveFreeRunCaps,
} from '@server/skillMarket/templateFreeRun';
import { isPublicTemplatePage } from '@server/skillMarket/templateImage';
import { findServableTemplate } from '@server/skillMarket/templatePage';
import { getTurnstileFreeRunPolicy } from '@server/utils/auth/turnstile';
import { ipSubject } from '@server/utils/otcLimits';

/**
 * POST /api/skills/template/run/[slug] - the signed-out free run from a public template page
 * (server/skillMarket/templateFreeRun.ts). Order as in pages/api/subscribers/create.ts: blocked IP,
 * Turnstile, then rate limits. The challenge is required whenever this route runs: with Turnstile
 * unconfigured or unverifiable the route refuses rather than skipping it.
 *
 * Every refusal the page acts on carries a `code`: `free_run_used` and `free_run_capped` swap the run
 * box for the sign-up prompt.
 */

type Refusal = { status: number; code: string; error: string };

const UNAVAILABLE: Refusal = { status: 403, code: 'free_run_unavailable', error: 'This skill has no free run.' };
const NOT_FOUND: Refusal = { status: 404, code: 'not_found', error: 'Not found' };
const USED: Refusal = {
  status: 429,
  code: 'free_run_used',
  error: 'You have used your free run. Sign up to keep going.',
};
const CAPPED: Refusal = {
  status: 429,
  code: 'free_run_capped',
  error: 'Free runs are used up for now. Sign up to keep going.',
};
const FAILED: Refusal = {
  status: 502,
  code: 'free_run_failed',
  error: 'The run could not finish. Try again in a moment.',
};

const refuse = (req: Request, res: Response, refusal: Refusal) =>
  res.status(refusal.status).json({ error: refusal.error, code: refusal.code, request_id: req.requestId });

const requireFreeRunTurnstile: RequestHandler = async (req, res, next) => {
  const policy = await getTurnstileFreeRunPolicy().catch(error => {
    req.logger?.warn('skill-free-run: turnstile policy unreadable', error);
    return null;
  });
  if (!policy?.active) {
    return refuse(req, res, { status: 503, code: 'challenge_unavailable', error: 'Free runs are unavailable.' });
  }
  const failure = await checkTurnstileToken(req, TURNSTILE_ACTION_SKILL_FREE_RUN, policy, req.body?.turnstileToken);
  if (failure) return refuse(req, res, failure);
  return next();
};

const handler = baseApi({ auth: false, allowedMethods: ['POST'] })
  .use(checkBlockedIP())
  .use(requireFreeRunTurnstile)
  .use(rateLimit({ bucket: 'skill-template-free-run', subject: ipSubject, limit: 10, windowMs: 60_000 }))
  .post(async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'private, no-store');

    const slug = req.query.slug;
    if (typeof slug !== 'string' || slug.length > SKILL_TEMPLATE_SLUG_MAX || !SKILL_TEMPLATE_SLUG_PATTERN.test(slug)) {
      return refuse(req, res, NOT_FOUND);
    }

    const settings = await loadFreeRunSettings();
    if (!settings.enabled) return refuse(req, res, UNAVAILABLE);

    const found = await findServableTemplate(slug);
    if (!found) return refuse(req, res, NOT_FOUND);
    const { template, listing } = found;
    if (!isPublicTemplatePage(listing) || !template.freeRunEnabled) return refuse(req, res, UNAVAILABLE);

    const { snapshot } = await approvedSnapshotOf(listing);
    if (!skillTemplateFreeRunEligibility(snapshot).eligible) return refuse(req, res, UNAVAILABLE);

    if (hasUsedFreeRun(req.headers.cookie)) return refuse(req, res, USED);

    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) return refuse(req, res, { status: 400, code: 'input_required', error: 'Paste some text to run.' });
    if (text.length > settings.inputMaxChars) {
      return refuse(req, res, {
        status: 400,
        code: 'input_too_long',
        error: `Keep it under ${settings.inputMaxChars.toLocaleString('en-US')} characters.`,
      });
    }

    const reservation = await reserveFreeRunCaps({
      templateId: String(template._id),
      ipBucket: ipSubject(req),
      settings,
    });
    if (!reservation.ok) {
      req.logger?.info('skill-free-run: cap reached', { refusal: reservation.refusal });
      return refuse(req, res, CAPPED);
    }

    let answer: string;
    try {
      const { system, user } = buildFreeRunMessages(snapshot, text);
      answer = await completeFreeRun({
        model: settings.model,
        system,
        user,
        maxTokens: settings.outputMaxTokens,
        logger: req.logger,
      });
    } catch (error) {
      if (!(error instanceof FreeRunTimeoutError)) {
        await reservation
          .release()
          .catch(releaseError => req.logger?.warn('skill-free-run: cap release failed', releaseError));
      }
      req.logger?.warn('skill-free-run: model call failed', error);
      return refuse(req, res, FAILED);
    }

    res.setHeader('Set-Cookie', freeRunCookieHeader(isSecureRequest(req)));
    await recordTemplateFreeRun(template._id).catch(error =>
      req.logger?.warn('skill-free-run: count update failed', error)
    );
    return res.status(200).json(renderFreeRunResult(answer));
  });

function isSecureRequest(req: Request): boolean {
  const proto = String(req.headers['x-forwarded-proto'] ?? '')
    .split(',')[0]
    .trim();
  return proto ? proto === 'https' : process.env.NODE_ENV === 'production';
}

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
