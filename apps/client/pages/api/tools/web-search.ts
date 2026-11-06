import { outboundActionGate } from '@server/auth/assertOutboundActionAllowed';
import { baseApi } from '@server/middlewares/baseApi';
import { ApiKeyScope } from '@bike4mind/common';
import { toolRoutesRateLimit } from '@server/middlewares/toolRoutesRateLimit';
import { runAuditedTool } from '@server/cli/runAuditedTool';
import { billedWebSearch } from '@server/billing/billedWebTools';
import { resolveRequestUsageSource } from '@server/utils/resolveRequestUsageSource';
import { z } from 'zod';

const WebSearchBodySchema = z.object({
  query: z.string(),
  num_results: z.number().optional(),
});

// One hourly budget shared across the three /api/tools/* routes (see toolRoutesRateLimit). Embed
// (confined) keys hold neither scope, so they are refused. Each search is billed per call
// (billedWebSearch): a 422 insufficient_credits before the provider is called when the payer is out.
const handler = baseApi({ requiredScopes: [ApiKeyScope.AI_CHAT, ApiKeyScope.AI_GENERATE] })
  .use(toolRoutesRateLimit())
  .post(outboundActionGate(), async (req, res) =>
    runAuditedTool('web_search', req.user!.id, req.logger, async () => {
      const { query, num_results } = WebSearchBodySchema.parse(req.body);

      // billedWebSearch runs performWebSearch, so this endpoint honors the configured provider
      // (SerpAPI or local SearXNG) and its not-configured messaging, same as the tool.
      const { formattedResults } = await billedWebSearch(
        { caller: req, source: resolveRequestUsageSource(req) },
        { query, num_results }
      );

      return res.json({
        result: formattedResults,
      });
    })
  );

export default handler;
