import { resolveDocOrigin } from '@bike4mind/server-utils/services/publish/viewerSecurity';
import { baseApi } from '@client/server/middlewares/baseApi';
import { renderTemplatePage, templatePageCsp } from '@server/skillMarket/templatePage';
import { buildTemplatePageView, findOwnPreviewTemplate } from '@server/skillMarket/templatePageView';

/**
 * GET /api/skills/market/[id]/template/preview (skillTemplatePreviewPath) - the author's template page
 * as the public page would draw it, drafts included, with the free-run box inert. Author only; the
 * editor embeds it, so it may only be framed by this origin.
 */
const handler = baseApi({ auth: 'jwtOnly', allowedMethods: ['GET'] }).get(async (req, res) => {
  const { template, listing, isPublic } = await findOwnPreviewTemplate(req.user!, String(req.query.id));
  const view = await buildTemplatePageView({
    template,
    listing,
    isPublic,
    origin: resolveDocOrigin(req.headers.host, req.headers['x-forwarded-proto']),
    preview: true,
    logger: req.logger,
  });
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy', templatePageCsp(view));
  res.status(200).send(renderTemplatePage(view));
});

export default handler;
