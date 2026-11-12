import { randomUUID } from 'node:crypto';
import {
  BadRequestError,
  WORK_ITEM_PRIORITIES,
  type WorkItemPatch,
  type WorkItemPriority,
  type WorkItemStageBy,
  type WorkItemStatus,
} from '@bike4mind/common';
import {
  initialStageHistory,
  priorityPatch,
  ticketMovePatch,
  UNSURE_PREFIX,
  unsureReason,
} from '@bike4mind/common/loops';
import type { LocalLoop, LocalTicket } from '@shared/localLoops';
import { applyTicketPatch, type LocalLoopStore } from './LocalLoopStore';

/**
 * Ticket writes for Desktop loops, with the server's rules: the owner's (IPC) and a run's `loop_ticket_*` tools
 * both come here. Ported from apps/workers/src/queueHandlers/agentExecutor.loopTicketTools.ts minus hand-offs and
 * desktop stages (every stage of a Desktop loop runs here). A refusal throws BadRequestError.
 */

const TITLE_MAX = 300;
const DESCRIPTION_MAX = 10_000;
const QUESTION_MAX = 1000;
const LIST_DESCRIPTION_CHARS = 500;
const SPLIT_MIN = 2;
const SPLIT_MAX = 20;
const SIBLING_REF = /^\$(\d+)$/;
/** ponytail: per-run cap on tickets a run files, as on the server; per-run budgets are later work. */
export const MAX_TICKET_CREATES_PER_RUN = 20;

const title = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim()) throw new BadRequestError('title is required');
  if (value.length > TITLE_MAX) throw new BadRequestError(`title must be at most ${TITLE_MAX} characters`);
  return value.trim();
};

const description = (value: unknown): string | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new BadRequestError('description must be a string');
  if (value.length > DESCRIPTION_MAX)
    throw new BadRequestError(`description must be at most ${DESCRIPTION_MAX} characters`);
  return value;
};

const priority = (value: unknown): WorkItemPriority | undefined => {
  if (value === undefined || value === null) return undefined;
  if (!WORK_ITEM_PRIORITIES.includes(value as WorkItemPriority))
    throw new BadRequestError(`priority must be one of: ${WORK_ITEM_PRIORITIES.join(', ')}`);
  return value as WorkItemPriority;
};

/** Dependencies are tickets of the same loop, never the ticket itself or anything that waits on it. */
function dependencies(store: LocalLoopStore, loopId: string, value: unknown, self?: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string'))
    throw new BadRequestError('dependencies must be an array of ticket ids');
  const ids = [...new Set(value as string[])];
  const byId = new Map(store.tickets(loopId).map(ticket => [ticket.id, ticket]));
  for (const id of ids) if (!byId.has(id)) throw new BadRequestError(`dependency ${id} is not a ticket of this loop`);
  if (self) {
    const seen = new Set<string>();
    const reaches = (id: string): boolean =>
      id === self || (!seen.has(id) && (seen.add(id), (byId.get(id)?.dependencies ?? []).some(reaches)));
    if (ids.some(reaches)) throw new BadRequestError('a ticket cannot depend on itself, directly or through others');
  }
  return ids;
}

/** assertBlockedOnSatisfiable: parking on dependencies needs one still open, or it would never reopen. */
function assertBlockedOnSatisfiable(store: LocalLoopStore, deps: string[], blockedOn: WorkItemPatch['blockedOn']) {
  if (blockedOn !== 'dependencies') return;
  if (!deps.some(id => store.ticket(id)?.status !== 'closed'))
    throw new BadRequestError('blockedOn dependencies needs at least one open dependency');
}

export const summarize = (ticket: LocalTicket) => ({
  id: ticket.id,
  title: ticket.title,
  ...(ticket.description && { description: ticket.description.slice(0, LIST_DESCRIPTION_CHARS) }),
  stage: ticket.stage,
  status: ticket.status,
  ...(ticket.statusReason && { statusReason: ticket.statusReason }),
  ...(ticket.blockedOn && { blockedOn: ticket.blockedOn }),
  ...(ticket.priority && { priority: ticket.priority }),
  ...(ticket.epic && { epic: true }),
  dependencies: ticket.dependencies,
});

function newTicket(
  loop: LocalLoop,
  fields: Omit<Partial<LocalTicket>, 'stageHistory'>,
  move: WorkItemPatch
): LocalTicket {
  const now = new Date().toISOString();
  const base: LocalTicket = {
    id: randomUUID(),
    loopId: loop.id,
    title: '',
    stage: move.stage!,
    status: move.status!,
    dependencies: [],
    runCount: 0,
    stageHistory: [],
    createdAt: now,
    updatedAt: now,
    ...fields,
  };
  return applyTicketPatch(base, { ...move, ...initialStageHistory(move) }, new Date(now));
}

export interface TicketFields {
  title?: unknown;
  description?: unknown;
  stage?: unknown;
  status?: unknown;
  reason?: unknown;
  priority?: unknown;
  blockedOn?: unknown;
  dependencies?: unknown;
}

export function createTicket(
  store: LocalLoopStore,
  loop: LocalLoop,
  params: TicketFields,
  by: Extract<WorkItemStageBy, 'run' | 'owner'>
): LocalTicket {
  if (params.status !== undefined && !['open', 'blocked'].includes(params.status as string))
    throw new BadRequestError('status must be one of: open, blocked');
  const deps = dependencies(store, loop.id, params.dependencies) ?? [];
  const set = priority(params.priority);
  const move = ticketMovePatch(
    loop,
    undefined,
    {
      stage: params.stage,
      status: params.status as WorkItemStatus | undefined,
      reason: params.reason,
      blockedOn: params.blockedOn,
    },
    by
  );
  assertBlockedOnSatisfiable(store, deps, move.blockedOn);
  const desc = description(params.description);
  const ticket = newTicket(
    loop,
    { title: title(params.title), ...(desc ? { description: desc } : {}), dependencies: deps },
    move
  );
  return store.putTicket(
    set ? applyTicketPatch(ticket, priorityPatch(set, by === 'owner' ? 'owner' : 'agent')) : ticket
  );
}

/** Edit, re-prioritize, move, block or close. `priority: null` clears it (owner only). */
export function updateTicket(
  store: LocalLoopStore,
  loop: LocalLoop,
  existing: LocalTicket,
  params: TicketFields,
  by: Extract<WorkItemStageBy, 'run' | 'owner'>
): LocalTicket {
  if (params.status !== undefined && !['open', 'blocked', 'closed'].includes(params.status as string))
    throw new BadRequestError('status must be one of: open, blocked, closed');
  const deps = dependencies(store, loop.id, params.dependencies, existing.id);
  const patch: WorkItemPatch = {
    ...(params.title !== undefined && { title: title(params.title) }),
    ...(params.description !== undefined && { description: description(params.description) ?? null }),
    ...(deps && { dependencies: deps }),
    ...(params.priority === null && by === 'owner'
      ? priorityPatch(null, 'owner')
      : params.priority !== undefined && priorityPatch(priority(params.priority)!, by === 'owner' ? 'owner' : 'agent')),
    ...((params.stage !== undefined || params.status !== undefined || params.blockedOn != null) &&
      ticketMovePatch(
        loop,
        existing,
        {
          stage: params.stage,
          status: params.status as WorkItemStatus | undefined,
          reason: params.reason,
          blockedOn: params.blockedOn,
        },
        by
      )),
  };
  assertBlockedOnSatisfiable(store, deps ?? existing.dependencies, patch.blockedOn);
  // The owner moving a ticket starts its run count over, as on the server.
  const moved = by === 'owner' && patch.stage !== undefined && patch.stage !== existing.stage;
  return store.putTicket(applyTicketPatch(existing, { ...patch, ...(moved && { runCount: 0 }) }));
}

/** The run a tool call belongs to: its loop, and the ticket it works (absent on a triage run). */
export interface ToolRun {
  loopId: string;
  ticketId?: string;
  runId: string;
  /** Tickets this run has filed so far. */
  creates: number;
}

/**
 * One `loop_ticket_*` call of a Desktop loop run. Returns the text the model sees: JSON, or `Error: ...` for a
 * refusal it can act on (as the server's asToolResult).
 */
export function runTicketTool(
  store: LocalLoopStore,
  run: ToolRun,
  tool: string,
  input: Record<string, unknown>,
  onAsked: (ticket: LocalTicket, question: string) => void
): string {
  try {
    return JSON.stringify(store.transaction(() => ticketTool(store, run, tool, input, onAsked)));
  } catch (error) {
    if (error instanceof BadRequestError) return `Error: ${error.message}`;
    throw error;
  }
}

function ticketTool(
  store: LocalLoopStore,
  run: ToolRun,
  tool: string,
  input: Record<string, unknown>,
  onAsked: (ticket: LocalTicket, question: string) => void
): unknown {
  const loop = store.loop(run.loopId);
  if (!loop) throw new BadRequestError('loop not found');
  const own = (id: unknown): LocalTicket => {
    const ticket = typeof id === 'string' ? store.ticket(id) : null;
    if (!ticket || ticket.loopId !== loop.id) throw new BadRequestError('ticket not found');
    return ticket;
  };
  const files = (count: number) => {
    if (run.creates + count > MAX_TICKET_CREATES_PER_RUN)
      throw new BadRequestError(`at most ${MAX_TICKET_CREATES_PER_RUN} tickets can be created per run`);
  };

  switch (tool) {
    case 'loop_ticket_list': {
      const status = typeof input.status === 'string' ? input.status : undefined;
      return {
        loopId: loop.id,
        stages: loop.stages,
        tickets: store
          .tickets(loop.id)
          .filter(ticket => (status ? ticket.status === status : ticket.status !== 'closed'))
          .filter(ticket => !input.stage || ticket.stage === input.stage)
          .slice(0, 100)
          .map(summarize),
      };
    }
    case 'loop_ticket_create': {
      files(1);
      const created = createTicket(store, loop, input, 'run');
      run.creates++;
      return summarize(created);
    }
    case 'loop_ticket_update':
      return summarize(updateTicket(store, loop, own(input.id), input, 'run'));
    case 'loop_ticket_unsure': {
      const question = typeof input.question === 'string' ? input.question.trim().slice(0, QUESTION_MAX) : '';
      if (!question) throw new BadRequestError('question is required');
      const existing = own(input.id);
      if (existing.status === 'closed') throw new BadRequestError('ticket is closed');
      if (existing.status === 'blocked' && existing.statusReason?.startsWith(UNSURE_PREFIX)) {
        return 'This ticket is already waiting on the owner. Their answer reaches your next run; do not ask again.';
      }
      const updated = store.putTicket(
        applyTicketPatch(
          existing,
          ticketMovePatch(loop, existing, { status: 'blocked', reason: unsureReason(question) }, 'run')
        )
      );
      onAsked(updated, question);
      return summarize(updated);
    }
    case 'loop_ticket_split':
      return split(store, loop, own(input.id), input.children, files, run);
    default:
      throw new BadRequestError(`unknown tool ${tool}`);
  }
}

function split(
  store: LocalLoopStore,
  loop: LocalLoop,
  existing: LocalTicket,
  raw: unknown,
  files: (count: number) => void,
  run: ToolRun
) {
  if (existing.status !== 'open' || existing.epic)
    throw new BadRequestError('only an open, unsplit ticket can be split');
  if (!Array.isArray(raw) || raw.length < SPLIT_MIN || raw.length > SPLIT_MAX)
    throw new BadRequestError(`children must be an array of ${SPLIT_MIN} to ${SPLIT_MAX} tickets`);
  files(raw.length);
  // Every child is checked before anything is written.
  const children = raw.map((entry: unknown, index) => {
    const child = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    const set = priority(child.priority);
    if (!set) throw new BadRequestError(`children[${index}].priority is required`);
    const refs = Array.isArray(child.dependencies) ? (child.dependencies as unknown[]) : [];
    const isSibling = (dep: unknown) => typeof dep === 'string' && SIBLING_REF.test(dep);
    const siblings = refs.filter(isSibling).map(dep => {
      const sibling = Number(SIBLING_REF.exec(dep as string)![1]);
      if (sibling >= index) throw new BadRequestError(`children[${index}] can only depend on earlier children`);
      return sibling;
    });
    const external =
      dependencies(
        store,
        loop.id,
        refs.filter(dep => !isSibling(dep)),
        existing.id
      ) ?? [];
    const move = ticketMovePatch(loop, undefined, { stage: child.stage }, 'run');
    if (move.status === 'closed') throw new BadRequestError(`children[${index}] cannot start in the last stage`);
    const desc = description(child.description);
    return {
      fields: { title: title(child.title), ...(desc ? { description: desc } : {}) },
      move,
      priority: set,
      siblings,
      // The epic's own dependencies still hold for the work it is split into.
      external: [...new Set([...existing.dependencies, ...external])],
    };
  });
  const ids: string[] = [];
  for (const child of children) {
    const ticket = newTicket(
      loop,
      { ...child.fields, dependencies: [...child.external, ...child.siblings.map(sibling => ids[sibling])] },
      child.move
    );
    ids.push(store.putTicket(applyTicketPatch(ticket, priorityPatch(child.priority, 'agent'))).id);
  }
  run.creates += ids.length;
  const epic = store.putTicket(
    applyTicketPatch(existing, {
      status: 'blocked',
      blockedOn: 'dependencies',
      dependencies: ids,
      epic: true,
      statusReason: `Epic: waiting on ${ids.length} child tickets`,
      ...priorityPatch(null, 'agent'),
    })
  );
  return { epic: summarize(epic), children: ids };
}
