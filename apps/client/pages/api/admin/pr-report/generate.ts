/**
 * POST /api/admin/pr-report/generate
 *
 * Phase one of the two-phase digest flow. READ-ONLY: it fetches, classifies and
 * renders, and returns editable text. It NEVER posts - a human reviews and edits the
 * text, then calls the send endpoint explicitly.
 *
 * Admin-gated. Generation reads repo-wide PR and staffing data and burns rate-limit
 * budget, so it is not safe to expose broadly even though it writes nothing.
 */

import { baseApi } from '@client/server/middlewares/baseApi';
import { prReportService } from '@bike4mind/services';
import { BadRequestError, ForbiddenError } from '@bike4mind/utils';

import { assertRepoFormat } from '@server/services/prReport/guards';
import { createGenerateDeps, loadPrReportConfig } from '@server/services/prReport/context';

const handler = baseApi().post(async (req, res) => {
  if (!req.user?.isAdmin) {
    throw new ForbiddenError('Admin access required');
  }

  const config = await loadPrReportConfig();

  if (!config.repo) {
    throw new BadRequestError('No PR report repository is configured (admin setting: prReportRepo)');
  }

  // Surfaced as a 400 with its own message rather than being swallowed into the
  // generic upstream-failure path below - this is a settings problem the admin can
  // fix, and the SSRF guard's reason names which rule the value broke.
  try {
    assertRepoFormat(config.repo);
  } catch (error) {
    throw new BadRequestError(
      `Invalid prReportRepo setting: ${error instanceof Error ? error.message : 'unrecognized format'}`
    );
  }

  // Only STRUCTURAL spec errors block here (no catch-all, duplicate order, a roster with
  // no roleKey or no specificOwner) - each fails silently and daily and is invisible from
  // inside a report. A roster whose role key is merely unmapped is NOT blocking: it rides
  // along as a `rosterWarnings` advisory below, because the renderer already omits the
  // pool mention and a blank or partial identity map is a legitimate configuration.
  if (config.specErrors.length) {
    throw new BadRequestError(
      `Bucket configuration is invalid: ${config.specErrors
        .map(specError => `${specError.bucket} - ${specError.reason}`)
        .join('; ')}`
    );
  }

  const outcome = await prReportService.generateReport(
    {
      repo: config.repo,
      identityLookup: config.identityLookup,
      bucketSpecs: config.bucketSpecs,
    },
    createGenerateDeps(req.logger)
  );

  if (!outcome.ok) {
    if (outcome.failure.kind === 'rateLimited') {
      const { retryAfterSeconds, resetAt } = outcome.failure.rateLimit;
      // Carried all the way to the admin so they are told WHEN to retry. A generic
      // 500 here is the whole failure mode this arm exists to prevent: an admin told
      // only "rate limited" retries immediately and re-burns the throttled budget.
      if (retryAfterSeconds !== null) res.setHeader('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({
        kind: 'rateLimited',
        rateLimit: { retryAfterSeconds, resetAt },
      });
    }

    // Upstream detail is logged, not returned.
    req.logger.error('[PrReport] Generate failed', { reason: outcome.failure.reason });
    return res.status(502).json({ kind: 'error', reason: 'Failed to fetch pull requests from GitHub' });
  }

  // `identityMapErrors` and `rosterWarnings` ride along so the admin UI can show, next to
  // the report the map produced, the line-numbered parse problems and the roster pools
  // that will post without an @-mention. Both non-blocking: a partly-configured map still
  // mentions everyone who resolved.
  return res.status(200).json({
    ...outcome.response,
    identityMapErrors: config.identityMapErrors,
    rosterWarnings: config.rosterWarnings,
  });
});

export default handler;
