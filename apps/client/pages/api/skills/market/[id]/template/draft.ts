// apps/client/pages/api/skills/market/[id]/template/draft.ts
import { baseApi } from '@client/server/middlewares/baseApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { resolveUserRateLimitPerMin } from '@bike4mind/server-utils/utils/userRateTier';
import { getOperationsClassifierLlm } from '@server/skillMarket/classifySkill';
import { approvedSnapshotForDraft } from '@server/skillMarket/template';
import { EMPTY_TEMPLATE_DRAFT, draftTemplateCopy } from '@server/skillMarket/templateDraft';

const HOUR_MS = 60 * 60 * 1000;

/**
 * POST /api/skills/market/[id]/template/draft - drafted template copy from the listing's approved
 * version, for the editor's first open. Best-effort like suggest-tags: any failure past the author
 * check is an empty draft. Has its own rate-limit bucket so drafting never spends the scan budget.
 */
const handler = baseApi({ auth: 'jwtOnly' })
  .use(
    rateLimit({
      limit: async req =>
        (await resolveUserRateLimitPerMin(req.user, req)) > 0 ? (req.user?.isAdmin ? Infinity : 20) : 0,
      windowMs: HOUR_MS,
      bucket: 'skill-market-template-draft',
    })
  )
  .post(async (req, res) => {
    const user = req.user!;
    const { snapshot, versionId } = await approvedSnapshotForDraft(user, String(req.query.id));

    let draft = EMPTY_TEMPLATE_DRAFT;
    try {
      const llm = await getOperationsClassifierLlm(req.logger, user.id, { maxTokens: 800 });
      draft = await draftTemplateCopy(snapshot, llm);
    } catch (error) {
      req.logger.warn('[skill-market] template draft failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    res.json({ draft, generatedFromVersionId: versionId });
  });

export default handler;
