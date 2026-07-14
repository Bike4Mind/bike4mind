import { baseApi } from '@server/middlewares/baseApi';
import { adminSettingsRepository, apiKeyRepository } from '@bike4mind/database';
import { firecrawlFetch, webFetchBody } from '@bike4mind/services/llm/tools/implementation/webfetch';
import { z } from 'zod';

const WebFetchBodySchema = z.object({
  url: z.url().refine(val => /^https?:\/\//i.test(val), {
    error: 'URL must use http or https protocol',
  }),
  offset: z.coerce.number().int().min(0).optional(),
});

const handler = baseApi().post(async (req, res) => {
  const { url, offset } = WebFetchBodySchema.parse(req.body);

  const dbAdapters = {
    db: {
      apiKeys: apiKeyRepository,
      adminSettings: adminSettingsRepository,
    },
  };

  // Frontend Lambda has a 60s timeout - cap Firecrawl timeout to leave headroom for response
  const result = await firecrawlFetch(dbAdapters, url, {
    maxTimeoutMs: 55_000,
    offset,
  });

  const body = webFetchBody(result);
  const formattedResult = result.title ? `# ${result.title}\n\n${body}` : body;

  return res.json({
    result: formattedResult,
  });
});

export default handler;
