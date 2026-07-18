import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { B4mApiClient } from './b4mApiClient.js';
import { mapApiError } from './b4mApiClient.js';

const NOTEBOOK_URI_TEMPLATE = 'b4m://notebook/{id}';

/**
 * Register the `b4m://notebook/{id}` resource. `list` enumerates the caller's
 * notebooks via GET /api/sessions; `read` returns one notebook's JSON via
 * GET /api/sessions/:id. Both are notebooks:read operations.
 */
export function registerResources(server: McpServer, client: B4mApiClient): void {
  server.registerResource(
    'notebook',
    new ResourceTemplate(NOTEBOOK_URI_TEMPLATE, {
      list: async () => {
        try {
          const { data } = await client.listNotebooks({ limit: 100 });
          return {
            resources: data.map(n => ({
              uri: `b4m://notebook/${n.id}`,
              name: n.name ?? n.id,
              mimeType: 'application/json',
            })),
          };
        } catch (err) {
          throw new Error(mapApiError(err, client.baseURL, 'notebooks:read'));
        }
      },
    }),
    { title: 'Notebook', description: 'A Bike4Mind notebook (session)', mimeType: 'application/json' },
    async (uri, variables) => {
      const id = String(variables.id);
      try {
        const notebook = await client.getNotebook(id);
        return {
          contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(notebook, null, 2) }],
        };
      } catch (err) {
        throw new Error(mapApiError(err, client.baseURL, 'notebooks:read'));
      }
    }
  );
}
