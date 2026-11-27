import type { NextFunction, Request, Response } from 'express';
import { SKILL_TEMPLATE_SLUG_MAX, SKILL_TEMPLATE_SLUG_PATTERN } from '@bike4mind/common';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { resolveDocOrigin } from '@bike4mind/server-utils/services/publish/viewerSecurity';
import { audienceIdsFor, canSeeListing } from '@bike4mind/server-utils/skillMarket/market';
import { getClientIp } from '@bike4mind/server-utils/utils/ip';
import { baseApi } from '@server/middlewares/baseApi';
import { optionalJwtAuth } from '@server/middlewares/optionalJwtAuth';
import { renderNotFoundPage } from '@server/services/publish/renderNotFoundPage';
import { isPublicTemplatePage } from '@server/skillMarket/templateImage';
import { isCrawlerUserAgent } from '@server/utils/crawlerUserAgent';
import {
  findServableTemplate,
  recordTemplateView,
  renderTemplateLoaderShell,
  renderTemplatePage,
  templatePageCsp,
  TEMPLATE_EXAMPLE_SCRIPT_HASH,
  TEMPLATE_LOADER_SCRIPT_HASH,
  TEMPLATE_PAGE_BASE_CSP,
} from '@server/skillMarket/templatePage';
import { buildTemplatePageView } from '@server/skillMarket/templatePageView';

/**
 * GET /t/<slug> (rewritten here by next.config.mjs): a published template's public page, modeled on
 * pages/api/publish/serve/[...path].ts. Public and unlisted listings render for anyone. Organization
 * and Space listings render only for a signed-in member, with no link-preview tags; a browser
 * navigation gets the sign-in loader, which re-fetches with `?raw=1` and a Bearer token.
 */

const optionalJwtShim = optionalJwtAuth();

const PAGE_CSP = TEMPLATE_PAGE_BASE_CSP.join('; ');
// A member render is document.written into the loader's document, so it runs under this policy: the
// example script's hash must be here as well.
const LOADER_CSP = [
  ...TEMPLATE_PAGE_BASE_CSP,
  `script-src ${TEMPLATE_LOADER_SCRIPT_HASH} ${TEMPLATE_EXAMPLE_SCRIPT_HASH}`,
  "connect-src 'self'",
].join('; ');

function runShim(
  shim: (req: Request, res: Response, next: NextFunction) => unknown,
  req: Request,
  res: Response
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const next: NextFunction = (err?: unknown) =>
      err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve();
    Promise.resolve(shim(req, res, next)).catch(reject);
  });
}

function sendHtml(res: Response, status: number, html: string, csp: string) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy', csp);
  return res.status(status).send(html);
}

// One answer for every slug that resolves to nothing, so a probe cannot tell the cases apart.
function sendNotFound(req: Request, res: Response) {
  res.setHeader('Vary', 'Accept');
  if (!String(req.headers.accept ?? '').includes('text/html')) return res.status(404).json({ error: 'Not found' });
  return sendHtml(res, 404, renderNotFoundPage(), PAGE_CSP);
}

const userIdOf = (req: Request): string | undefined => (req.user as { id?: string } | undefined)?.id;

const handler = baseApi({ auth: false, allowedMethods: ['GET'] })
  .use(rateLimit({ limit: 120, windowMs: 60_000, bucket: 'GET /t' }))
  .get(async (req: Request, res: Response) => {
    // no-store so an unpublish or withdrawal takes effect at once and every visit reaches the view counter.
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const slug = req.query.slug;
    if (typeof slug !== 'string' || slug.length > SKILL_TEMPLATE_SLUG_MAX || !SKILL_TEMPLATE_SLUG_PATTERN.test(slug)) {
      return sendNotFound(req, res);
    }

    await runShim(optionalJwtShim, req, res);
    if (res.headersSent) return;

    const found = await findServableTemplate(slug);
    if (!found) return sendNotFound(req, res);
    const { template, listing } = found;
    const isPublic = isPublicTemplatePage(listing);
    const raw = req.query.raw === '1';

    if (!isPublic) {
      const userId = userIdOf(req);
      if (!userId) {
        if (raw) return res.status(401).json({ error: 'Sign in to view this page' });
        return sendHtml(res, 200, renderTemplateLoaderShell(slug), LOADER_CSP);
      }
      if (!canSeeListing(listing, await audienceIdsFor(userId))) return sendNotFound(req, res);
    }

    const origin = resolveDocOrigin(req.headers.host, req.headers['x-forwarded-proto']);
    const view = await buildTemplatePageView({
      template,
      listing,
      isPublic,
      origin,
      cookieHeader: req.headers.cookie,
      logger: req.logger,
    });
    const html = renderTemplatePage(view);

    if (!isCrawlerUserAgent(req.headers['user-agent'])) {
      const visitor = { userId: userIdOf(req), ip: getClientIp(req), userAgent: req.headers['user-agent'] };
      await recordTemplateView(template, visitor).catch(error =>
        req.logger?.warn('template page: view count update failed', error)
      );
    }

    if (raw) {
      // Inert on a direct navigation; the loader writes it into its own document.
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      return res.status(200).send(html);
    }
    return sendHtml(res, 200, html, templatePageCsp(view));
  });

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
