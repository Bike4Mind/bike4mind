/**
 * The `loop_ticket_*` tools a loop run uses to read and file tickets (loop-linked WorkItems) in its own
 * loop or any other loop of the same user. Built per execution, closing over the run's owner and loop, and
 * never added to `b4mTools`, so nothing outside a loop run can be offered them.
 *
 * Like Lattice (`agentExecutor.latticeTools.ts`) the names are appended after profile resolution and the
 * definitions merged into `externalTools`, so an exclusive orchestration profile cannot drop them. The gate
 * (`execution.loopId` + `EnableLoops`) is re-read on every invocation, so a continuation keeps them.
 * Headless loop runs pre-approve them in `startAgentExecution`. Stage rule: `@server/utils/loopTickets`.
 */
import {
  desktopStagesOf,
  LOOP_TICKET_TOOL_NAMES,
  WORK_ITEM_BLOCKERS,
  WORK_ITEM_PRIORITIES,
  WORK_ITEM_STATUSES,
  type ILoop,
  type IWorkItem,
  type WorkItemPatch,
  type WorkItemStatus,
} from '@bike4mind/common';
import { loopEventRepository, loopRepository, workItemRepository } from '@bike4mind/database';
import type { ToolDefinition } from '@bike4mind/services/llm';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { ConflictError } from '@bike4mind/server-utils/utils/errors';
import {
  assertBlockedOnSatisfiable,
  assertCloudRunMayChange,
  makeDueIfReady,
  priorityPatch,
  ticketMovePatch,
  UNSURE_PREFIX,
  unsureReason,
} from '@server/utils/loopTickets';
import { assertDependenciesUsable } from '@server/utils/workItemDependencies';
import { pushLoopChanged, requestLoopDispatch } from '@server/utils/loopDispatch';
import { Logger } from '@bike4mind/observability';
import {
  validateWorkItemDependencies,
  validateWorkItemDescription,
  validateWorkItemPriority,
  validateWorkItemTitle,
} from '@server/utils/workItemValidation';

/** ponytail: per-invocation cap on loop_ticket_create, so a runaway run cannot flood a loop. Per-run budgets are later work. */
export const MAX_TICKET_CREATES_PER_INVOCATION = 20;
const LIST_DESCRIPTION_CHARS = 500;
const LIST_LIMIT = 100;

/** Same text for another user's loop and a missing one, so a refusal never confirms a foreign loop exists. */
export const LOOP_NOT_FOUND = 'loop not found';
const TICKET_NOT_FOUND = 'ticket not found';
// Only for the best-effort dispatch and push warnings; the tools have no request logger in scope.
const logger = new Logger();
const QUESTION_MAX = 1000;
const SPLIT_MIN = 2;
const SPLIT_MAX = 20;
/** A split child's dependency on an earlier sibling: `$0` is the first child. */
const SIBLING_REF = /^\$(\d+)$/;

interface LoopTicketScope {
  userId: string;
  loopId: string;
  executionId: string;
}

export interface LoopTicketToolContribution {
  loopTicketEnabledTools: readonly string[];
  loopTicketExternalTools: Record<string, ToolDefinition>;
}

export function resolveLoopTicketTools({
  loopId,
  loopsEnabled,
  userId,
  executionId,
}: {
  loopId?: string;
  loopsEnabled: boolean;
  userId: string;
  executionId: string;
}): LoopTicketToolContribution {
  if (!loopId || !loopsEnabled) return { loopTicketEnabledTools: [], loopTicketExternalTools: {} };
  return {
    loopTicketEnabledTools: LOOP_TICKET_TOOL_NAMES,
    loopTicketExternalTools: buildLoopTicketTools({ userId, loopId, executionId }),
  };
}

const summarize = (ticket: IWorkItem, desktopStages: string[] = []) => ({
  id: ticket.id,
  loopId: ticket.loopId,
  title: ticket.title,
  ...(ticket.description && { description: ticket.description.slice(0, LIST_DESCRIPTION_CHARS) }),
  stage: ticket.stage,
  status: ticket.status,
  ...(ticket.statusReason && { statusReason: ticket.statusReason }),
  ...(ticket.blockedOn && { blockedOn: ticket.blockedOn }),
  // Absent: untriaged, waiting for a triage run to set it.
  ...(ticket.priority && { priority: ticket.priority }),
  ...(ticket.epic && { epic: true }),
  dependencies: ticket.dependencies,
  ...(ticket.stage && desktopStages.includes(ticket.stage) && { desktopRunner: true }),
});

const PRIORITY_PARAM = {
  type: 'string',
  enum: [...WORK_ITEM_PRIORITIES],
  description:
    'p0: drop everything, p1: next up, p2: normal, p3: someday. p0 is worked first, p3 last. Without one the ticket waits for a triage run to set it.',
};
const BLOCKED_ON_PARAM = {
  type: 'string',
  enum: [...WORK_ITEM_BLOCKERS],
  description:
    'With status blocked: park the ticket until every listed dependency closes. It then reopens on its own and the owner is not notified. Needs at least one open dependency.',
};

/** Validation and authz errors go back to the model as the tool result; anything else is a real failure. */
export async function asToolResult(run: () => Promise<unknown>): Promise<string> {
  try {
    return JSON.stringify(await run());
  } catch (error) {
    if (error instanceof BadRequestError || error instanceof NotFoundError || error instanceof ConflictError) {
      return `Error: ${error.message}`;
    }
    throw error;
  }
}

export function buildLoopTicketTools({ userId, loopId, executionId }: LoopTicketScope): Record<string, ToolDefinition> {
  let creates = 0;

  /** After a ticket write: make the loop due if it has a ready ticket, ask for a dispatch, refresh its open page. */
  const ticketsChanged = async (loop: ILoop) => {
    await makeDueIfReady(loop);
    await requestLoopDispatch(loop.id, logger);
    await pushLoopChanged(userId, loop.id, logger);
  };

  const ownLoop = async (id: unknown): Promise<ILoop> => {
    const loop = typeof id === 'string' ? await loopRepository.findByIdAndUserId(id, userId) : null;
    if (!loop) throw new NotFoundError(LOOP_NOT_FOUND);
    return loop;
  };

  const list: ToolDefinition = {
    name: 'loop_ticket_list',
    implementation: () => ({
      toolFn: async value =>
        asToolResult(async () => {
          const params = (value ?? {}) as { loopId?: string; stage?: string; status?: string };
          const loop = await ownLoop(params.loopId ?? loopId);
          const tickets = await workItemRepository.listForUser(
            userId,
            {
              loopId: loop.id,
              // Closed tickets only on request, so they don't crowd open work out of the page.
              status: WORK_ITEM_STATUSES.includes(params.status as WorkItemStatus)
                ? [params.status as WorkItemStatus]
                : WORK_ITEM_STATUSES.filter(status => status !== 'closed'),
            },
            { page: 1, limit: LIST_LIMIT },
            { by: 'createdAt', direction: 'asc' }
          );
          const desktopStages = desktopStagesOf(loop);
          return {
            loopId: loop.id,
            stages: loop.stages,
            ...(desktopStages.length > 0 && { desktopStages }),
            tickets: tickets.data
              .filter(t => !params.stage || t.stage === params.stage)
              .map(t => summarize(t, desktopStages)),
            hasMore: tickets.hasMore,
          };
        }),
      toolSchema: {
        name: 'loop_ticket_list',
        description:
          "List the tickets of this loop (or another of the owner's loops by loopId), with their stage and status. Tickets marked desktopRunner sit in a stage the owner's desktop app works: never work, edit or move them.",
        parameters: {
          type: 'object',
          properties: {
            loopId: { type: 'string', description: 'Defaults to the loop this run belongs to.' },
            stage: { type: 'string', description: 'Only tickets in this stage.' },
            status: { type: 'string', enum: [...WORK_ITEM_STATUSES], description: 'Only tickets with this status.' },
          },
        },
      },
    }),
  };

  const create: ToolDefinition = {
    name: 'loop_ticket_create',
    implementation: () => ({
      toolFn: async value =>
        asToolResult(async () => {
          if (creates >= MAX_TICKET_CREATES_PER_INVOCATION) {
            throw new BadRequestError(`at most ${MAX_TICKET_CREATES_PER_INVOCATION} tickets can be created per run`);
          }
          const params = (value ?? {}) as {
            title?: unknown;
            description?: unknown;
            loopId?: unknown;
            stage?: unknown;
            dependencies?: unknown;
            status?: unknown;
            reason?: unknown;
            priority?: unknown;
            blockedOn?: unknown;
          };
          const loop = await ownLoop(params.loopId ?? loopId);
          if (params.status !== undefined && !['open', 'blocked'].includes(params.status as string)) {
            throw new BadRequestError('status must be one of: open, blocked');
          }
          const title = validateWorkItemTitle(params.title);
          const description = validateWorkItemDescription(params.description);
          const dependencies = validateWorkItemDependencies(params.dependencies) ?? [];
          await assertDependenciesUsable(userId, dependencies);
          const priority = validateWorkItemPriority(params.priority);
          const move = ticketMovePatch(loop, undefined, {
            stage: params.stage,
            status: params.status as WorkItemStatus | undefined,
            reason: params.reason,
            blockedOn: params.blockedOn,
          });
          await assertBlockedOnSatisfiable(userId, dependencies, move.blockedOn);

          creates++;
          const created = await workItemRepository.create({
            userId,
            loopId: loop.id,
            title,
            ...(description ? { description } : {}),
            dependencies,
            stage: move.stage!,
            status: move.status!,
            ...(priority && priorityPatch(priority, 'agent')),
            ...(move.closedAt && { closedAt: move.closedAt }),
            ...(move.statusReason && { statusReason: move.statusReason }),
            ...(move.blockedOn && { blockedOn: move.blockedOn }),
          } as Omit<IWorkItem, 'id' | 'createdAt' | 'updatedAt'>);
          await ticketsChanged(loop);
          return summarize(created);
        }),
      toolSchema: {
        name: 'loop_ticket_create',
        description:
          "File a ticket into this loop or another of the owner's loops (by loopId). A ticket starts in the loop's first stage unless a stage is given; the target loop works it on its next run. To file a step only the owner can do (a decision, credentials, a human-only action), set status blocked with a reason: the owner is notified. To hold a ticket until other tickets close, list them as dependencies and set status blocked with blockedOn dependencies instead: it reopens on its own and the owner is not notified.",
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Short title (300 characters max).' },
            description: { type: 'string', description: 'What needs doing (10,000 characters max).' },
            loopId: { type: 'string', description: 'Target loop. Defaults to the loop this run belongs to.' },
            stage: { type: 'string', description: "One of the target loop's stages. Defaults to its first stage." },
            status: { type: 'string', enum: ['open', 'blocked'], description: 'Defaults to open.' },
            reason: {
              type: 'string',
              description: 'Required when status is blocked without blockedOn: what the owner needs to do.',
            },
            priority: PRIORITY_PARAM,
            blockedOn: BLOCKED_ON_PARAM,
            dependencies: {
              type: 'array',
              items: { type: 'string' },
              description: 'Ids of tickets that must close before this one is worked.',
            },
          },
          required: ['title'],
        },
      },
    }),
  };

  const update: ToolDefinition = {
    name: 'loop_ticket_update',
    implementation: () => ({
      toolFn: async value =>
        asToolResult(async () => {
          const params = (value ?? {}) as {
            id?: unknown;
            title?: unknown;
            description?: unknown;
            stage?: unknown;
            status?: unknown;
            reason?: unknown;
            loopId?: unknown;
            priority?: unknown;
            blockedOn?: unknown;
            dependencies?: unknown;
          };
          const existing =
            typeof params.id === 'string' ? await workItemRepository.findByIdForUser(params.id, userId) : null;
          // A plain work item (no loopId) is the user's own, not a loop's: it reads as missing here.
          if (!existing?.loopId) throw new NotFoundError(TICKET_NOT_FOUND);

          const movesLoop = params.loopId !== undefined && params.loopId !== existing.loopId;
          const current = await ownLoop(existing.loopId);
          // Setting only the priority does not work the ticket, so a triage run may set it in a desktop stage too.
          const onlyPriority = Object.entries(params).every(
            ([key, v]) => v === undefined || ['id', 'priority'].includes(key)
          );
          if (!onlyPriority) assertCloudRunMayChange(current, existing);
          const loop = movesLoop ? await ownLoop(params.loopId) : current;
          if (params.status !== undefined && !['open', 'blocked', 'closed'].includes(params.status as string)) {
            throw new BadRequestError('status must be one of: open, blocked, closed');
          }

          const dependencies = validateWorkItemDependencies(params.dependencies);
          if (dependencies) await assertDependenciesUsable(userId, dependencies, existing.id);
          const priority = validateWorkItemPriority(params.priority);
          const patch: WorkItemPatch = {
            ...(params.title !== undefined && { title: validateWorkItemTitle(params.title) }),
            ...(params.description !== undefined && { description: validateWorkItemDescription(params.description) }),
            ...(dependencies && { dependencies }),
            ...(priority && priorityPatch(priority, 'agent')),
            ...((movesLoop ||
              params.stage !== undefined ||
              params.status !== undefined ||
              params.blockedOn != null) && {
              loopId: loop.id,
              ...ticketMovePatch(loop, movesLoop ? undefined : existing, {
                stage: params.stage,
                status: params.status as WorkItemStatus | undefined,
                reason: params.reason,
                blockedOn: params.blockedOn,
              }),
            }),
          };
          await assertBlockedOnSatisfiable(userId, dependencies ?? existing.dependencies, patch.blockedOn);
          // Conditional on the status the patch was computed from, so a concurrent fold is not overwritten.
          const updated = await workItemRepository.updateForUser(existing.id, userId, patch, existing.status);
          if (!updated) throw new ConflictError('ticket changed while saving; list it again and retry');
          await ticketsChanged(loop);
          return summarize(updated);
        }),
      toolSchema: {
        name: 'loop_ticket_update',
        description:
          "Change a loop ticket: edit it, set its priority or dependencies, move it to another stage or another of the owner's loops, block it or close it. Moving a ticket to the last stage closes it. Block with a reason only for something the owner must do: they are notified. To wait on other tickets, set status blocked with blockedOn dependencies: it reopens on its own when they all close and the owner is not notified. A ticket in a stage the owner's desktop app works cannot be changed.",
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Ticket id.' },
            title: { type: 'string', description: 'New title (300 characters max).' },
            description: { type: 'string', description: 'New description (10,000 characters max).' },
            stage: { type: 'string', description: "One of the loop's stages." },
            status: { type: 'string', enum: ['open', 'blocked', 'closed'], description: 'New status.' },
            reason: { type: 'string', description: 'Required when status is blocked without blockedOn.' },
            priority: PRIORITY_PARAM,
            blockedOn: BLOCKED_ON_PARAM,
            dependencies: {
              type: 'array',
              items: { type: 'string' },
              description: 'Replaces the ids of tickets that must close before this one is worked.',
            },
            loopId: { type: 'string', description: "Move the ticket to another of the owner's loops." },
          },
          required: ['id'],
        },
      },
    }),
  };

  const unsure: ToolDefinition = {
    name: 'loop_ticket_unsure',
    implementation: () => ({
      toolFn: async value =>
        asToolResult(async () => {
          const params = (value ?? {}) as { id?: unknown; question?: unknown };
          const question = typeof params.question === 'string' ? params.question.trim().slice(0, QUESTION_MAX) : '';
          if (!question) throw new BadRequestError('question is required');
          const existing =
            typeof params.id === 'string' ? await workItemRepository.findByIdForUser(params.id, userId) : null;
          if (!existing || existing.loopId !== loopId) throw new NotFoundError(TICKET_NOT_FOUND);
          if (existing.status === 'closed') throw new BadRequestError('ticket is closed');
          // A second question would replace the first in the ticket's reason, so answering the first could no
          // longer reopen it. Not an error, so the model does not retry.
          if (existing.status === 'blocked' && existing.statusReason?.startsWith(UNSURE_PREFIX)) {
            return 'This ticket is already waiting on the owner. Their answer reaches your next run; do not ask again.';
          }
          const loop = await ownLoop(loopId);
          assertCloudRunMayChange(loop, existing);

          // Event first: if the ticket write then fails, the question is still in the Log and answerable,
          // instead of a ticket blocked with nothing to resolve it from. An answer landing in the ms between the
          // two writes leaves the ticket parked under a resolved event; the owner then moves it by hand.
          await loopEventRepository.recordUnsure({
            source: 'asked',
            loopId,
            userId,
            executionId,
            workItemId: existing.id,
            ticketTitle: existing.title,
            reason: question,
            requestedAt: new Date(),
          });
          const patch = ticketMovePatch(loop, existing, { status: 'blocked', reason: unsureReason(question) });
          const updated = await workItemRepository.updateForUser(existing.id, userId, patch, existing.status);
          // Not an error: the question is already recorded, and a retry would ask it twice.
          if (!updated) return 'Question recorded for the owner. The ticket changed meanwhile, so it was not parked.';
          await ticketsChanged(loop);
          return summarize(updated);
        }),
      toolSchema: {
        name: 'loop_ticket_unsure',
        description:
          'Ask the owner a question when the ticket is ambiguous or needs their decision. Parks the ticket as Unsure until they answer; their answer reaches your next run.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Id of a ticket in this loop.' },
            question: { type: 'string', description: 'What you need the owner to answer (1,000 characters max).' },
          },
          required: ['id', 'question'],
        },
      },
    }),
  };

  const split: ToolDefinition = {
    name: 'loop_ticket_split',
    implementation: () => ({
      toolFn: async value =>
        asToolResult(async () => {
          const params = (value ?? {}) as { id?: unknown; children?: unknown };
          const existing =
            typeof params.id === 'string' ? await workItemRepository.findByIdForUser(params.id, userId) : null;
          if (!existing?.loopId) throw new NotFoundError(TICKET_NOT_FOUND);
          const loop = await ownLoop(existing.loopId);
          assertCloudRunMayChange(loop, existing);
          if (existing.status !== 'open' || existing.epic)
            throw new BadRequestError('only an open, unsplit ticket can be split');
          const raw = params.children;
          if (!Array.isArray(raw) || raw.length < SPLIT_MIN || raw.length > SPLIT_MAX) {
            throw new BadRequestError(`children must be an array of ${SPLIT_MIN} to ${SPLIT_MAX} tickets`);
          }
          if (creates + raw.length > MAX_TICKET_CREATES_PER_INVOCATION) {
            throw new BadRequestError(`at most ${MAX_TICKET_CREATES_PER_INVOCATION} tickets can be created per run`);
          }

          // Every child is checked before anything is written.
          const children = raw.map((entry: unknown, index) => {
            const child = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
            const priority = validateWorkItemPriority(child.priority);
            if (!priority) throw new BadRequestError(`children[${index}].priority is required`);
            const refs = Array.isArray(child.dependencies) ? (child.dependencies as unknown[]) : [];
            const isSibling = (dep: unknown) => typeof dep === 'string' && SIBLING_REF.test(dep);
            const siblings = refs.filter(isSibling).map(dep => {
              const sibling = Number(SIBLING_REF.exec(dep as string)![1]);
              if (sibling >= index) throw new BadRequestError(`children[${index}] can only depend on earlier children`);
              return sibling;
            });
            const dependencies =
              validateWorkItemDependencies(
                Array.isArray(child.dependencies) ? refs.filter(dep => !isSibling(dep)) : child.dependencies
              ) ?? [];
            const move = ticketMovePatch(loop, undefined, { stage: child.stage });
            // A child placed in the last stage would be closed on arrival, so the epic's split would mean nothing.
            if (move.status === 'closed') {
              throw new BadRequestError(`children[${index}] cannot start in the last stage`);
            }
            return {
              title: validateWorkItemTitle(child.title),
              description: validateWorkItemDescription(child.description),
              stage: move.stage!,
              priority,
              siblings,
              // The epic's own dependencies still hold for the work it is split into.
              external: [...new Set([...existing.dependencies, ...dependencies])],
            };
          });
          // With the epic's id, so a child cannot depend on the epic it unblocks (directly or through another ticket).
          await assertDependenciesUsable(userId, [...new Set(children.flatMap(child => child.external))], existing.id);

          creates += children.length;
          const ids: string[] = [];
          const now = new Date();
          try {
            for (const child of children) {
              const created = await workItemRepository.create({
                userId,
                loopId: loop.id,
                title: child.title,
                ...(child.description ? { description: child.description } : {}),
                dependencies: [...child.external, ...child.siblings.map(sibling => ids[sibling])],
                stage: child.stage,
                status: 'open',
                ...priorityPatch(child.priority, 'agent', now),
              } as Omit<IWorkItem, 'id' | 'createdAt' | 'updatedAt'>);
              ids.push(created.id);
            }
            // Conditional on 'open', so a ticket a fold or the owner changed meanwhile is not turned into an epic.
            const epic = await workItemRepository.updateForUser(
              existing.id,
              userId,
              {
                status: 'blocked',
                blockedOn: 'dependencies',
                dependencies: ids,
                epic: true,
                statusReason: `Epic: waiting on ${ids.length} child tickets`,
                ...priorityPatch(null, 'agent'),
              },
              'open'
            );
            if (!epic) throw new ConflictError('ticket changed while splitting; list it again and retry');
            await makeDueIfReady(loop);
            return { epic: summarize(epic), children: ids };
          } catch (error) {
            // ponytail: not a transaction; a crash between the creates and the epic write leaves the children behind.
            // Best effort, so a failed cleanup does not hide why the split failed.
            await Promise.all(ids.map(id => workItemRepository.softDeleteForUser(id, userId))).catch(() => undefined);
            throw error;
          }
        }),
      toolSchema: {
        name: 'loop_ticket_split',
        description:
          'Split a ticket too big for one pass through the loop\'s stages into 2-20 child tickets in the same loop. The ticket becomes an epic: it waits on its children and closes on its own once they all close. Give every child a priority. A child may depend on an earlier child by its index ("$0" is the first) or on existing ticket ids.',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Id of an open ticket to split.' },
            children: {
              type: 'array',
              description: `${SPLIT_MIN} to ${SPLIT_MAX} child tickets.`,
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string', description: 'Short title (300 characters max).' },
                  description: { type: 'string', description: 'What needs doing (10,000 characters max).' },
                  stage: { type: 'string', description: "One of the loop's stages. Defaults to its first stage." },
                  priority: PRIORITY_PARAM,
                  dependencies: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Earlier children as "$<index>", or existing ticket ids.',
                  },
                },
                required: ['title', 'priority'],
              },
            },
          },
          required: ['id', 'children'],
        },
      },
    }),
  };

  return {
    loop_ticket_split: split,
    loop_ticket_list: list,
    loop_ticket_create: create,
    loop_ticket_update: update,
    loop_ticket_unsure: unsure,
  };
}
