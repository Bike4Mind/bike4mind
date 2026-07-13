import { baseApi } from '@server/middlewares/baseApi';
import { adminSettingsRepository, apiKeyRepository } from '@bike4mind/database';
import { firecrawlFetch, truncationMarker } from '@bike4mind/services/llm/tools/implementation/webfetch';
import { z } from 'zod';

const WebFetchBodySchema = z.object({
  url: z.url().refine(val => /^https?:\/\//i.test(val), {
    error: 'URL must use http or https protocol',
  }),
});

const handler = baseApi().post(async (req, res) => {
  const { url } = WebFetchBodySchema.parse(req.body);

  const dbAdapters = {
    db: {
      apiKeys: apiKeyRepository,
      adminSettings: adminSettingsRepository,
    },
  };

  // Frontend Lambda has a 60s timeout - cap Firecrawl timeout to leave headroom for response
  const { markdown, title, truncated, originalChars, cap } = await firecrawlFetch(dbAdapters, url, {
    maxTimeoutMs: 55_000,
  });

  const body = truncated ? markdown + truncationMarker(originalChars, cap) : markdown;
  const formattedResult = title ? `# ${title}\n\n${body}` : body;

  return res.json({
    result: formattedResult,
  });
});

export default handler;
