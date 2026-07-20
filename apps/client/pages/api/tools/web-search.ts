import { baseApi } from '@server/middlewares/baseApi';
import { adminSettingsRepository, apiKeyRepository } from '@bike4mind/database';
import { performWebSearch } from '@bike4mind/services/llm/tools/implementation/websearch';
import { z } from 'zod';

const WebSearchBodySchema = z.object({
  query: z.string(),
  num_results: z.number().optional(),
});

const handler = baseApi().post(async (req, res) => {
  const { query, num_results } = WebSearchBodySchema.parse(req.body);

  const dbAdapters = {
    db: {
      apiKeys: apiKeyRepository,
      adminSettings: adminSettingsRepository,
    },
  };

  // Route through performWebSearch so this endpoint honors the configured provider
  // (SerpAPI or local SearXNG) and its not-configured messaging, same as the tool.
  const { formattedResults } = await performWebSearch(dbAdapters, { query, num_results });

  return res.json({
    result: formattedResults,
  });
});

export default handler;
