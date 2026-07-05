import { baseApi } from '@server/middlewares/baseApi';
import { adminSettingsRepository, apiKeyRepository } from '@bike4mind/database';
import { serpApiSearch } from '@bike4mind/services/llm/tools/implementation/websearch';
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

  const searchResults = await serpApiSearch(dbAdapters, query, num_results);

  const results = searchResults.organic_results
    ?.map(
      (result: any, index: number) =>
        `${index + 1}. **${result.title}**\n${result.snippet}\n` +
        `Source: [${new URL(result.link).hostname}](${result.link})\n`
    )
    .join('\n');

  const formattedResult = results
    ? `Here's what I found from searching the web:\n\n${results}`
    : 'No results found from web search.';

  return res.json({
    result: formattedResult,
  });
});

export default handler;
