import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { B4mApiClient, mapApiError, type RawNotebook } from './b4mApiClient.js';

/** Static metadata for each tool, used for registration and the `mcp serve` help text. */
export interface ToolMeta {
  name: string;
  title: string;
  description: string;
  /** API-key scope the tool needs; named in a 403 error so callers know what to grant. */
  scope: string;
}

export const TOOL_META: ToolMeta[] = [
  {
    name: 'list_notebooks',
    title: 'List notebooks',
    description: "List the caller's Bike4Mind notebooks (sessions).",
    scope: 'notebooks:read',
  },
  {
    name: 'get_notebook',
    title: 'Get notebook',
    description: 'Fetch a single notebook by id.',
    scope: 'notebooks:read',
  },
  {
    name: 'create_notebook',
    title: 'Create notebook',
    description:
      'Create a new notebook, optionally inside a project. Defaults the name to "New Notebook" when omitted.',
    scope: 'notebooks:write',
  },
  {
    name: 'send_message',
    title: 'Send message',
    description: 'Send a chat message and wait for the assistant reply.',
    scope: 'ai:chat',
  },
  {
    name: 'search_knowledge_base',
    title: 'Search knowledge base',
    description: "Semantic search across the caller's notebooks.",
    scope: 'notebooks:read',
  },
  { name: 'list_files', title: 'List files', description: "Search the caller's files.", scope: 'files:read' },
  {
    name: 'get_file',
    title: 'Get file',
    description: "Fetch a file's metadata and a signed download URL.",
    scope: 'files:read',
  },
];

export const TOOL_NAMES = TOOL_META.map(t => t.name);

const listNotebooksShape = {
  search: z.string().optional().describe('Filter notebooks by name/content'),
  limit: z.number().int().min(1).max(100).default(25).describe('Maximum notebooks to return'),
  page: z.number().int().min(1).default(1).describe('1-based page number; request the next page when hasMore is true'),
};

const getNotebookShape = {
  notebookId: z.string().describe('The notebook (session) id'),
};

const createNotebookShape = {
  name: z.string().optional().describe('Name for the new notebook'),
  projectId: z.string().optional().describe('Project to create the notebook in'),
};

const sendMessageShape = {
  message: z.string().describe('The message to send'),
  notebookId: z.string().optional().describe('Notebook to send to; defaults to the most recent'),
  model: z.string().optional().describe('Model id to use; defaults to the instance default'),
};

const searchKnowledgeBaseShape = {
  query: z.string().describe('The search query'),
  limit: z.number().int().min(1).max(100).default(10).describe('Maximum results to return'),
  minSimilarity: z.number().min(0).max(1).optional().describe('Minimum cosine similarity threshold'),
};

const listFilesShape = {
  search: z.string().optional().describe('Filter files by name/content'),
  limit: z.number().int().min(1).max(100).default(25).describe('Maximum files to return'),
  page: z.number().int().min(1).default(1).describe('1-based page number; request the next page when hasMore is true'),
};

const getFileShape = {
  fileId: z.string().describe('The file id'),
};

function notebookSummary(n: RawNotebook) {
  return {
    id: n.id,
    name: n.name,
    model: n.lastUsedModel ?? undefined,
    createdAt: n.createdAt ?? n.firstCreated,
    updatedAt: n.updatedAt ?? n.lastUpdated,
  };
}

export async function listNotebooks(client: B4mApiClient, args: { search?: string; limit: number; page?: number }) {
  const { data, hasMore } = await client.listNotebooks(args);
  return { notebooks: data.map(notebookSummary), hasMore };
}

export async function getNotebook(client: B4mApiClient, args: { notebookId: string }) {
  return client.getNotebook(args.notebookId);
}

export async function createNotebook(client: B4mApiClient, args: { name?: string; projectId?: string }) {
  // POST /api/sessions/create hard-requires a name; default to the web app's
  // convention when the caller omits one so a nameless create still succeeds.
  return client.createNotebook({ ...args, name: args.name ?? 'New Notebook' });
}

export async function sendMessage(
  client: B4mApiClient,
  args: { message: string; notebookId?: string; model?: string }
) {
  const res = await client.sendChat(args);
  const questId = res.id;

  // The chat response omits the session id, so when the server auto-selected the
  // notebook (none supplied) resolve it from the quest - best-effort, since the
  // reply already succeeded and the id is a convenience for continuing the thread.
  let notebookId = args.notebookId;
  if (!notebookId) {
    try {
      notebookId = (await client.getQuest(questId)).sessionId;
    } catch {
      notebookId = undefined;
    }
  }

  // The completed quest carries the assistant reply in `responses` (a string
  // array); the scalar `response` is null on the wait path, so prefer `responses`.
  const reply = res.responses && res.responses.length > 0 ? res.responses.join('\n\n') : (res.response ?? '');

  return { notebookId, questId, reply, model: res.model };
}

export async function searchKnowledgeBase(
  client: B4mApiClient,
  args: { query: string; limit: number; minSimilarity?: number }
) {
  const results = await client.searchKnowledgeBase(args);
  return { results };
}

export async function listFiles(client: B4mApiClient, args: { search?: string; limit: number; page?: number }) {
  const { data, hasMore } = await client.listFiles(args);
  return { files: data, hasMore };
}

export async function getFile(client: B4mApiClient, args: { fileId: string }) {
  return client.getFile(args.fileId);
}

function toResult(value: unknown): CallToolResult {
  const structuredContent =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { result: value };
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent,
  };
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Register the seven Bike4Mind tools on `server`. Each handler is wrapped so an
 * API failure becomes a structured `isError` result carrying a friendly message
 * (see {@link mapApiError}) rather than throwing across the transport.
 */
export function registerTools(server: McpServer, client: B4mApiClient): void {
  const baseURL = client.baseURL;
  const meta = (name: string) => TOOL_META.find(t => t.name === name)!;

  const run = async (scope: string, fn: () => Promise<unknown>): Promise<CallToolResult> => {
    try {
      return toResult(await fn());
    } catch (err) {
      return errorResult(mapApiError(err, baseURL, scope));
    }
  };

  server.registerTool(
    'list_notebooks',
    {
      title: meta('list_notebooks').title,
      description: meta('list_notebooks').description,
      inputSchema: listNotebooksShape,
    },
    args => run('notebooks:read', () => listNotebooks(client, args))
  );

  server.registerTool(
    'get_notebook',
    { title: meta('get_notebook').title, description: meta('get_notebook').description, inputSchema: getNotebookShape },
    args => run('notebooks:read', () => getNotebook(client, args))
  );

  server.registerTool(
    'create_notebook',
    {
      title: meta('create_notebook').title,
      description: meta('create_notebook').description,
      inputSchema: createNotebookShape,
    },
    args => run('notebooks:write', () => createNotebook(client, args))
  );

  server.registerTool(
    'send_message',
    { title: meta('send_message').title, description: meta('send_message').description, inputSchema: sendMessageShape },
    args => run('ai:chat', () => sendMessage(client, args))
  );

  server.registerTool(
    'search_knowledge_base',
    {
      title: meta('search_knowledge_base').title,
      description: meta('search_knowledge_base').description,
      inputSchema: searchKnowledgeBaseShape,
    },
    args => run('notebooks:read', () => searchKnowledgeBase(client, args))
  );

  server.registerTool(
    'list_files',
    { title: meta('list_files').title, description: meta('list_files').description, inputSchema: listFilesShape },
    args => run('files:read', () => listFiles(client, args))
  );

  server.registerTool(
    'get_file',
    { title: meta('get_file').title, description: meta('get_file').description, inputSchema: getFileShape },
    args => run('files:read', () => getFile(client, args))
  );
}
