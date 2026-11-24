import type { NextFunction, Request, Response } from 'express';
import { SKILL_TEMPLATE_SLUG_MAX, SKILL_TEMPLATE_SLUG_PATTERN, skillTemplatePreviewImagePath } from '@bike4mind/common';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { resolveDocOrigin } from '@bike4mind/server-utils/services/publish/viewerSecurity';
import { audienceIdsFor, canSeeListing } from '@bike4mind/server-utils/skillMarket/market';
import { getBrandName } from '@client/config/general';
import { baseApi } from '@server/middlewares/baseApi';
import { optionalJwtAuth } from '@server/middlewares/optionalJwtAuth';
import { renderNotFoundPage } from '@server/services/publish/renderNotFoundPage';
import { isPublicTemplatePage, templateImageDeps, templatePageImageFile } from '@server/skillMarket/templateImage';
import { freeRunPageState } from '@server/skillMarket/templateFreeRun';
import {
  MERMAID_SCRIPT_SRC,
  TEMPLATE_FREE_RUN_SCRIPT_HASH,
  TEMPLATE_LOADER_SCRIPT_HASH,
  TURNSTILE_ORIGIN,
  findServableTemplate,
  recordTemplateView,
  renderTemplateLoaderShell,
  renderTemplatePage,
  type ServableTemplate,
} from '@server/skillMarket/templatePage';
import { getOpenSignupStarterCredits } from '@server/utils/starterCredits';

/**
 * GET /t/<slug> (rewritten here by next.config.mjs): a published template's public page, modeled on
 * pages/api/publish/serve/[...path].ts. Public and unlisted listings render for anyone. Organization
 * and Space listings render only for a signed-in member, with no link-preview tags; a browser
 * navigation gets the sign-in loader, which re-fetches with `?raw=1` and a Bearer token.
 */

const optionalJwtShim = optionalJwtAuth();

const BASE_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  // A member render signs its image on the storage origin, which differs per deployment.
  "img-src 'self' data: https:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
];
const PAGE_CSP = BASE_CSP.join('; ');
// A page with the free-run box also runs its script, the Turnstile widget and, for a diagram, mermaid.
const FREE_RUN_PAGE_CSP = [
  ...BASE_CSP,
  `script-src ${TEMPLATE_FREE_RUN_SCRIPT_HASH} ${TURNSTILE_ORIGIN} ${MERMAID_SCRIPT_SRC}`,
  `frame-src ${TURNSTILE_ORIGIN}`,
  "connect-src 'self'",
].join('; ');
const LOADER_CSP = [...BASE_CSP, `script-src ${TEMPLATE_LOADER_SCRIPT_HASH}`, "connect-src 'self'"].join('; ');

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
    // no-store so an unpublish or withdrawal takes effect at once and every view is counted.
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
        return sendHtml(res, 200, renderTemplateLoaderShell(), LOADER_CSP);
      }
      if (!canSeeListing(listing, await audienceIdsFor(userId))) return sendNotFound(req, res);
    }

    const origin = resolveDocOrigin(req.headers.host, req.headers['x-forwarded-proto']);
    const [imageSrc, starterCredits, freeRun] = await Promise.all([
      imageSrcFor(template, listing, isPublic),
      isPublic ? getOpenSignupStarterCredits() : Promise.resolve(0),
      freeRunPageState(template, listing, req.headers.cookie).catch(error => {
        req.logger?.warn('template page: free-run state unreadable', error);
        return null;
      }),
    ]);
    const brandName = getBrandName();
    const html = renderTemplatePage({
      slug: template.slug,
      skillName: listing.name,
      headline: template.headline,
      inputs: template.inputs,
      imageSrc,
      starterCredits,
      brandName,
      share: isPublic
        ? {
            canonicalUrl: `${origin}/t/${encodeURIComponent(template.slug)}`,
            imageUrl: imageSrc ? `${origin}${imageSrc}` : null,
            siteName: process.env.APP_NAME || brandName,
          }
        : null,
      freeRun,
    });

    await recordTemplateView(template).catch(error =>
      req.logger?.warn('template page: view count update failed', error)
    );

    if (raw) {
      // Inert on a direct navigation; the loader writes it into its own document.
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      return res.status(200).send(html);
    }
    return sendHtml(res, 200, html, freeRun?.state === 'open' ? FREE_RUN_PAGE_CSP : PAGE_CSP);
  });

/**
 * Public pages point at the cacheable public image route; a member-only page signs the file directly,
 * because that route serves nothing for a listing outside the public audience.
 */
async function imageSrcFor(
  template: ServableTemplate,
  listing: Parameters<typeof templatePageImageFile>[1],
  isPublic: boolean
): Promise<string | null> {
  const file = await templatePageImageFile(template, listing);
  if (!file || !template.previewImage) return null;
  if (isPublic) return skillTemplatePreviewImagePath(template.slug, template.previewImage.fabFileId);
  return templateImageDeps().signFileUrl(file.filePath, file.mimeType);
}

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
