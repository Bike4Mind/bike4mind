import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { B4mApiClient, RawArtifact, RawFile, RawNotebook, RawProject } from './b4mApiClient.js';
import { mapApiError } from './b4mApiClient.js';
import { logger } from '../utils/Logger.js';

// Resource listing takes no client-supplied paging. 100 is also the hard ceiling
// GET /api/artifacts enforces, so raising this needs that route revisited first.
const LIST_LIMIT = 100;

interface ResourceSpec<T> {
  /** Registration name; doubles as the `b4m://<name>/{id}` host segment. */
  name: string;
  title: string;
  description: string;
  /** Recommended API-key scope named in a 403 hint; omit where no scope exists. */
  scope?: string;
  list: () => Promise<T[]>;
  id: (item: T) => string;
  /** Display label; the raw id is used when this is undefined. */
  label: (item: T) => string | undefined;
  read: (id: string) => Promise<unknown>;
}

/**
 * Register one `b4m://<name>/{id}` JSON resource.
 *
 * `list` degrades to an empty array on failure rather than throwing: the SDK's
 * resources/list handler awaits every registered template's list callback in one
 * unguarded loop, so a throw here would also blank every sibling template. `read`
 * still throws - a single read failure has no fan-out.
 */
function registerJsonResource<T>(server: McpServer, client: B4mApiClient, spec: ResourceSpec<T>): void {
  server.registerResource(
    spec.name,
    new ResourceTemplate(`b4m://${spec.name}/{id}`, {
      list: async () => {
        try {
          const items = await spec.list();
          return {
            resources: items.map(item => ({
              // Raw id, deliberately not encodeURIComponent'd: UriTemplate.match()
              // never percent-decodes, and B4mApiClient encodes ids into REST paths.
              uri: `b4m://${spec.name}/${spec.id(item)}`,
              name: spec.label(item) ?? spec.id(item),
              mimeType: 'application/json',
            })),
          };
        } catch (err) {
          logger.error(`mcp: listing ${spec.name} resources failed: ${mapApiError(err, client.baseURL, spec.scope)}`);
          return { resources: [] };
        }
      },
    }),
    { title: spec.title, description: spec.description, mimeType: 'application/json' },
    async (uri, variables) => {
      const id = String(variables.id);
      try {
        const record = await spec.read(id);
        return {
          contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(record, null, 2) }],
        };
      } catch (err) {
        throw new Error(mapApiError(err, client.baseURL, spec.scope));
      }
    }
  );
}

/**
 * Register the Bike4Mind MCP resource templates. Each is served as
 * application/json and backed by its REST list/read pair.
 */
export function registerResources(server: McpServer, client: B4mApiClient): void {
  registerJsonResource<RawNotebook>(server, client, {
    name: 'notebook',
    title: 'Notebook',
    description: 'A Bike4Mind notebook (session)',
    scope: 'notebooks:read',
    list: async () => (await client.listNotebooks({ limit: LIST_LIMIT })).data,
    id: n => n.id,
    label: n => n.name,
    read: id => client.getNotebook(id),
  });

  registerJsonResource<RawFile>(server, client, {
    name: 'file',
    title: 'File',
    description: 'A Bike4Mind file: metadata plus a signed download URL',
    scope: 'files:read',
    list: async () => (await client.listFiles({ limit: LIST_LIMIT })).data,
    id: f => f.id,
    label: f => f.fileName,
    read: id => client.getFile(id),
  });

  registerJsonResource<RawProject>(server, client, {
    name: 'project',
    title: 'Project',
    description: 'A Bike4Mind project',
    scope: 'projects:read',
    list: async () => (await client.listProjects({ limit: LIST_LIMIT })).data,
    id: p => p.id,
    label: p => p.name,
    read: id => client.getProject(id),
  });

  registerJsonResource<RawArtifact>(server, client, {
    name: 'artifact',
    title: 'Artifact',
    description: 'A Bike4Mind artifact: metadata plus its current content',
    // Deliberately no `scope`: there is no artifacts:* API-key scope to grant, so
    // naming a proxy scope in a 403 would send the user hunting for a checkbox
    // that does not exist.
    list: async () => (await client.listArtifacts({ limit: LIST_LIMIT })).data,
    // The artifact id is the `id` string path, never `_id` (an unrelated ObjectId
    // that is also on the wire and would 404 on read).
    id: a => a.id,
    label: a => a.title,
    read: id => client.getArtifact(id),
  });
}
