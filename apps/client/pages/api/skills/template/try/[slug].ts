import { SKILL_TEMPLATE_SLUG_MAX, SKILL_TEMPLATE_SLUG_PATTERN, NotFoundError } from '@bike4mind/common';
import { importRateLimit } from '@bike4mind/server-utils/skillMarket/market';
import { baseApi } from '@server/middlewares/baseApi';
import { tryTemplate } from '@server/skillMarket/templateTry';

/**
 * POST /api/skills/template/try/[slug] - the signed-in visitor's "Try with Bike4Mind" from a template
 * page (app route /skills/market/try/$slug): reuse or import the skill (templateTry.ts). Draws on the
 * market import allowance, since it can import.
 */
const handler = baseApi({ auth: 'jwtOnly' })
  .use(importRateLimit())
  .post(async (req, res) => {
    const slug = req.query.slug;
    if (typeof slug !== 'string' || slug.length > SKILL_TEMPLATE_SLUG_MAX || !SKILL_TEMPLATE_SLUG_PATTERN.test(slug)) {
      throw new NotFoundError('Template not found');
    }
    res.status(200).json(await tryTemplate(req.user!, slug, req.logger));
  });

export default handler;
