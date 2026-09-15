import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';
import type { IWorkItem, IWorkItemGraph, WorkItemStatus } from '@bike4mind/common';
import { WORK_ITEM_STATUSES } from '@bike4mind/common';
import type { WorkItemsClient } from '../api/WorkItemsClient.js';

/**
 * Tools over the persistent `/api/work-items` store. Unlike `write_todos`,
 * which lives and dies with a session, these items are stored in B4M's Mongo,
 * so an agent can pick up work left behind by an earlier run or another
 * machine.
 *
 * Backend failures degrade to a readable message rather than an exception: the
 * CLI is expected to stay usable offline, and a hard failure here would derail
 * the ReAct loop mid-task. Malformed tool arguments still throw, so the model
 * sees them as a call it got wrong rather than as a result.
 */

/** Statuses that represent work still to be done. */
const UNFINISHED_STATUSES: WorkItemStatus[] = ['open', 'in_progress', 'blocked'];

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const STATUS_MARKER: Record<WorkItemStatus, string> = {
  open: '[ ]',
  in_progress: '[~]',
  blocked: '[!]',
  closed: '[x]',
};

function formatItem(item: IWorkItem): string {
  const base = `${STATUS_MARKER[item.status]} ${item.id} ${item.title}`;
  const deps = item.dependencies.length > 0 ? `\n    depends on: ${item.dependencies.join(', ')}` : '';
  return base + deps;
}

function formatItems(items: IWorkItem[], emptyMessage: string): string {
  if (items.length === 0) return emptyMessage;
  return items.map(formatItem).join('\n');
}

/**
 * The server computed the answer from a prefix of the backlog, so a dependency
 * outside the window read as satisfied. Say so rather than presenting a
 * possibly-wrong answer as authoritative.
 */
const TRUNCATION_WARNING =
  'WARNING: too many work items to analyse at once, so this was computed from the oldest items only. Some items may be listed as ready while a blocker outside that window is still open. Close or delete old items to get a complete answer.';

function withTruncationWarning(body: string, truncated: boolean): string {
  return truncated ? `${body}\n\n${TRUNCATION_WARNING}` : body;
}

function formatGraph(graph: IWorkItemGraph): string {
  if (graph.nodes.length === 0) return 'No work items yet.';

  const lines = [`${graph.nodes.length} item(s), ${graph.edges.length} dependency edge(s):`];
  const dependenciesById = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const existing = dependenciesById.get(edge.from) ?? [];
    existing.push(edge.to);
    dependenciesById.set(edge.from, existing);
  }

  for (const node of graph.nodes) {
    const deps = dependenciesById.get(node.id) ?? [];
    const suffix = deps.length > 0 ? ` -> ${deps.join(', ')}` : '';
    lines.push(`${STATUS_MARKER[node.status]} ${node.id} ${node.title}${suffix}`);
  }

  if (graph.cycles.length > 0) {
    lines.push('', `WARNING: dependency cycle involving: ${graph.cycles.join(', ')}`);
  }

  return withTruncationWarning(lines.join('\n'), graph.truncated);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The server answered but rejected the request. Axios hangs the response off
 * the error; its absence means the request never completed a round trip.
 */
function serverRejection(error: unknown): { status: number; message: string } | null {
  const response = (error as { response?: { status?: number; data?: unknown } } | undefined)?.response;
  if (!response || typeof response.status !== 'number') return null;

  const data = response.data;
  const message =
    (typeof data === 'object' && data !== null && typeof (data as { message?: unknown }).message === 'string'
      ? (data as { message: string }).message
      : undefined) ?? errorMessage(error);
  return { status: response.status, message };
}

/**
 * Run a backend call. A rejection from the server is reported verbatim because
 * it is actionable (a cycle, a bad id, a missing item); only a failed round
 * trip is reported as offline, so the agent falls back to session todos rather
 * than aborting the task.
 */
async function attempt<T>(toolName: string, run: () => Promise<T>, format: (value: T) => string): Promise<string> {
  try {
    return format(await run());
  } catch (error) {
    const rejection = serverRejection(error);
    if (rejection) {
      return `${toolName}: request rejected (HTTP ${rejection.status}): ${rejection.message}`;
    }
    return `${toolName}: work item backend unreachable (${errorMessage(error)}). Persistent work tracking is offline; session todos still work.`;
  }
}

function requireString(toolName: string, params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${toolName}: ${key} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(toolName: string, params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`${toolName}: ${key} must be a string`);
  }
  return value;
}

function parseStatus(toolName: string, value: unknown): WorkItemStatus | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !WORK_ITEM_STATUSES.includes(value as WorkItemStatus)) {
    throw new Error(`${toolName}: status must be one of ${WORK_ITEM_STATUSES.join(', ')}`);
  }
  return value as WorkItemStatus;
}

function parseStatusList(toolName: string, value: unknown): WorkItemStatus[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`${toolName}: status must be an array of status values`);
  }
  const statuses = value.map(entry => parseStatus(toolName, entry)).filter((s): s is WorkItemStatus => s !== undefined);
  return statuses.length > 0 ? statuses : undefined;
}

function parseDependencies(toolName: string, value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    throw new Error(`${toolName}: dependencies must be an array of work item ids`);
  }
  return value as string[];
}

export function createWorkItemTools(client: WorkItemsClient): ICompletionOptionTools[] {
  const readPriorTodos: ICompletionOptionTools = {
    toolFn: async (args: unknown) => {
      const params = (args ?? {}) as Record<string, unknown>;
      const status = parseStatusList('read_prior_todos', params.status) ?? UNFINISHED_STATUSES;
      const rawLimit = typeof params.limit === 'number' ? params.limit : DEFAULT_LIMIT;
      const limit = Math.min(Math.max(Math.trunc(rawLimit) || DEFAULT_LIMIT, 1), MAX_LIMIT);

      return attempt(
        'read_prior_todos',
        () => client.list({ status, limit, orderBy: 'updatedAt', orderDirection: 'desc' }),
        result => {
          const listing = formatItems(result.data, 'No unfinished work items from prior sessions.');
          const more = result.hasMore ? `\n(showing ${result.data.length} of ${result.total})` : '';
          return listing + more;
        }
      );
    },
    toolSchema: {
      name: 'read_prior_todos',
      description: `List persistent work items left over from earlier sessions or other machines.

This is the read half of the work_item_* tools, NOT of write_todos - it reads a
different, server-backed store, and nothing written with write_todos ever
appears here. Call it at the start of a session to find out what was already in
flight before deciding what to do next.

Defaults to unfinished work (open, in_progress, blocked).`,
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'array',
            description: 'Statuses to include. Defaults to open, in_progress and blocked.',
            items: { type: 'string', enum: [...WORK_ITEM_STATUSES] },
          },
          limit: {
            type: 'number',
            description: `Maximum items to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
          },
        },
        required: [],
      },
    },
  };

  const workItemCreate: ICompletionOptionTools = {
    toolFn: async (args: unknown) => {
      const params = (args ?? {}) as Record<string, unknown>;
      const title = requireString('work_item_create', params, 'title');
      const description = optionalString('work_item_create', params, 'description');
      const status = parseStatus('work_item_create', params.status);
      const dependencies = parseDependencies('work_item_create', params.dependencies);

      return attempt(
        'work_item_create',
        () =>
          client.create({
            title,
            ...(description !== undefined && { description }),
            ...(status !== undefined && { status }),
            ...(dependencies !== undefined && { dependencies }),
          }),
        item => `Created work item:\n${formatItem(item)}`
      );
    },
    toolSchema: {
      name: 'work_item_create',
      description: `Create a persistent work item that outlives this session.

Use for work that should still be tracked after the CLI exits - a follow-up
task, a deferred fix, a multi-session project step. For within-session task
tracking, use write_todos instead.

Declare dependencies when an item cannot start until other items close; a
dependency set that would form a cycle is rejected.`,
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short summary of the work' },
          description: { type: 'string', description: 'Optional detail, context or acceptance criteria' },
          status: {
            type: 'string',
            enum: [...WORK_ITEM_STATUSES],
            description: "Initial status. Defaults to 'open'.",
          },
          dependencies: {
            type: 'array',
            description: 'Ids of work items that must close before this one is actionable',
            items: { type: 'string' },
          },
        },
        required: ['title'],
      },
    },
  };

  const workItemUpdate: ICompletionOptionTools = {
    toolFn: async (args: unknown) => {
      const params = (args ?? {}) as Record<string, unknown>;
      const id = requireString('work_item_update', params, 'id');
      const title = params.title === undefined ? undefined : requireString('work_item_update', params, 'title');
      const description = optionalString('work_item_update', params, 'description');
      const status = parseStatus('work_item_update', params.status);
      const dependencies = parseDependencies('work_item_update', params.dependencies);

      if (title === undefined && description === undefined && status === undefined && dependencies === undefined) {
        throw new Error('work_item_update: provide at least one of title, description, status or dependencies');
      }

      return attempt(
        'work_item_update',
        () =>
          client.update(id, {
            ...(title !== undefined && { title }),
            ...(description !== undefined && { description }),
            ...(status !== undefined && { status }),
            ...(dependencies !== undefined && { dependencies }),
          }),
        item => `Updated work item:\n${formatItem(item)}`
      );
    },
    toolSchema: {
      name: 'work_item_update',
      description: `Update a persistent work item's title, description, status or dependencies.

Only the fields you pass are changed. Use work_item_close for the common
"this is done" transition.`,
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Id of the work item to update' },
          title: { type: 'string', description: 'New title' },
          description: { type: 'string', description: 'New description. Pass an empty string to clear it.' },
          status: { type: 'string', enum: [...WORK_ITEM_STATUSES], description: 'New status' },
          dependencies: {
            type: 'array',
            description: 'Replacement dependency list (replaces the existing one entirely)',
            items: { type: 'string' },
          },
        },
        required: ['id'],
      },
    },
  };

  const workItemClose: ICompletionOptionTools = {
    toolFn: async (args: unknown) => {
      const params = (args ?? {}) as Record<string, unknown>;
      const id = requireString('work_item_close', params, 'id');

      return attempt(
        'work_item_close',
        () => client.close(id),
        item => `Closed work item:\n${formatItem(item)}`
      );
    },
    toolSchema: {
      name: 'work_item_close',
      description: `Mark a persistent work item as closed.

Closing an item can unblock others that depend on it - check work_item_ready
afterwards to see what became actionable.`,
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Id of the work item to close' },
        },
        required: ['id'],
      },
    },
  };

  const workItemReady: ICompletionOptionTools = {
    toolFn: async () =>
      attempt(
        'work_item_ready',
        () => client.ready(),
        result => withTruncationWarning(formatItems(result.data, 'No work items are ready to start.'), result.truncated)
      ),
    toolSchema: {
      name: 'work_item_ready',
      description: `List open work items whose dependencies are all closed - what can be started right now.

Items that are already in_progress or deliberately blocked are excluded.`,
      parameters: { type: 'object', properties: {}, required: [] },
    },
  };

  const workItemGraph: ICompletionOptionTools = {
    toolFn: async () => attempt('work_item_graph', () => client.graph(), formatGraph),
    toolSchema: {
      name: 'work_item_graph',
      description: `Show the whole work item dependency graph - every item and what it waits on.

Use when you need to understand ordering across the backlog rather than just
the next actionable item.`,
      parameters: { type: 'object', properties: {}, required: [] },
    },
  };

  return [readPriorTodos, workItemCreate, workItemUpdate, workItemClose, workItemReady, workItemGraph];
}
