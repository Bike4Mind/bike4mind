import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@bike4mind/server-utils/middlewares/featureFlag';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import {
  agentRepository,
  customPageRepository,
  fabFileRepository,
  projectRepository,
  sessionRepository,
} from '@bike4mind/database';
import { customPageService } from '@bike4mind/services';
import { CreateCustomPageInput } from '@bike4mind/common';
import { respond } from '@server/utils/respond';
import { pageListResponseSchema, pageResponseSchema } from '@server/customPages/sendPageResult';

/**
 * GET  /api/pages - the caller's pages, without state or widgets.
 * POST /api/pages - create a page and its orchestrator session.
 */
const handler = baseApi({ auth: 'jwtOnly', allowedMethods: ['GET', 'POST'] })
  .use(requireFeatureEnabled('EnableCustomPages'))
  .use(rateLimit({ limit: 60, windowMs: 60 * 1000, bucket: 'pages' }))
  .get(async (req, res) => {
    const pages = await customPageRepository.listOwned(req.user.id);
    return respond(res, pageListResponseSchema, { pages });
  })
  .post(csrfProtection(), async (req, res) => {
    const parsed = CreateCustomPageInput.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid page', details: parsed.error.flatten() });
    }

    const page = await customPageService.createPage(req.user, parsed.data, {
      db: {
        sessions: sessionRepository,
        projects: projectRepository,
        fabFiles: fabFileRepository,
        agents: agentRepository,
        customPages: customPageRepository,
      },
      logger: req.logger,
    });
    return respond(res, pageResponseSchema, { page }, 201);
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;
