import { userRepository } from '@bike4mind/database';
import type { ServerToolExecutors } from '@bike4mind/services';
import { webFetchBody } from '@bike4mind/services/llm/tools/implementation/webfetch';
import { billedWebFetch, billedWebSearch, type WebToolCaller } from '@server/billing/billedWebTools';

/**
 * The CLI's `web_search` and `web_fetch` server tools, billed per call. They live in the app tier
 * because the credit hold does; the CLI Lambda, its local-dev Next route and the WebSocket tool handler
 * each wire them in, and cliTools.executeServerTool fails a tool whose executor is missing rather than
 * run it un-billed.
 *
 * The caller is the authenticated user. `apiKeyInfo` is set only by a handler that accepted an API key
 * (the WebSocket one), so an org-billed key bills its organization and a user-billed key the user, as on
 * every other route; a JWT caller bills its own organization seat, else itself.
 */
export function buildWebToolExecutors(
  logger: WebToolCaller['logger'],
  apiKeyInfo?: WebToolCaller['apiKeyInfo']
): Pick<ServerToolExecutors, 'web_search' | 'web_fetch'> {
  const callerFor = async (userId: string) => {
    const user = await userRepository.findById(userId);
    if (!user) throw new Error('No such user');
    return { caller: { user, apiKeyInfo, logger } satisfies WebToolCaller, source: 'cli' as const };
  };

  return {
    web_search: async request => {
      const { query, num_results } = request.input as { query?: unknown; num_results?: unknown };
      if (typeof query !== 'string') throw new Error('Invalid input: query must be a string');
      const { formattedResults } = await billedWebSearch(await callerFor(request.userId), {
        query,
        num_results: typeof num_results === 'number' ? num_results : undefined,
      });
      return formattedResults;
    },
    web_fetch: async request => {
      const { url, offset } = request.input as { url?: unknown; offset?: unknown };
      if (typeof url !== 'string') throw new Error('Invalid input: url must be a string');
      const result = await billedWebFetch(await callerFor(request.userId), {
        url,
        offset: typeof offset === 'number' ? offset : undefined,
      });
      // Shared formatter keeps truncation/continuation in-band and consistent with the web_fetch
      // tool and HTTP endpoint.
      return webFetchBody(result);
    },
  };
}
