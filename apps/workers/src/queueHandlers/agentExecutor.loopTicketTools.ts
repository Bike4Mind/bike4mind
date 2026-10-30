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
  LOOP_TICKET_TOOL_NAMES,
  WORK_ITEM_STATUSES,
  type ILoop,
  type IWorkItem,
  type WorkItemStatus,
} from '@bike4mind/common';
import { loopRepository, workItemRepository } from '@bike4mind/database';
import type { ToolDefinition } from '@bike4mind/services/llm';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { ConflictError } from '@bike4mind/server-utils/utils/errors';
import { makeDueIfReady, ticketMovePatch } from '@server/utils/loopTickets';
import { assertDependenciesUsable } from '@server/utils/workItemDependencies';
import {
  validateWorkItemDependencies,
  validateWorkItemDescription,
  validateWorkItemTitle,
} from '@server/utils/workItemValidation';

/** ponytail: per-invocation cap on loop_ticket_create, so a runaway run cannot flood a loop. Per-run budgets are later work. */
export const MAX_TICKET_CREATES_PER_INVOCATION = 20;
const LIST_DESCRIPTION_CHARS = 500;
const LIST_LIMIT = 100;

/** Same text for another user's loop and a missing one, so a refusal never confirms a foreign loop exists. */
const LOOP_NOT_FOUND = 'loop not found';
const TICKET_NOT_FOUND = 'ticket not found';

interface LoopTicketScope {
  userId: string;
  loopId: string;
}

export interface LoopTicketToolContribution {
  loopTicketEnabledTools: readonly string[];
  loopTicketExternalTools: Record<string, ToolDefinition>;
}

export function resolveLoopTicketTools({
  loopId,
  loopsEnabled,
  userId,
}: {
  loopId?: string;
  loopsEnabled: boolean;
  userId: string;
}): LoopTicketToolContribution {
  if (!loopId || !loopsEnabled) return { loopTicketEnabledTools: [], loopTicketExternalTools: {} };
  return {
    loopTicketEnabledTools: LOOP_TICKET_TOOL_NAMES,
    loopTicketExternalTools: buildLoopTicketTools({ userId, loopId }),
  };
}

const summarize = (ticket: IWorkItem) => ({
  id: ticket.id,
  loopId: ticket.loopId,
  title: ticket.title,
  ...(ticket.description && { description: ticket.description.slice(0, LIST_DESCRIPTION_CHARS) }),
  stage: ticket.stage,
  status: ticket.status,
  ...(ticket.statusReason && { statusReason: ticket.statusReason }),
  dependencies: ticket.dependencies,
});

/** Validation and authz errors go back to the model as the tool result; anything else is a real failure. */
async function asToolResult(run: () => Promise<unknown>): Promise<string> {
  try {
    return JSON.stringify(await run());
  } catch (error) {
    if (error instanceof BadRequestError || error instanceof NotFoundError || error instanceof ConflictError) {
      return `Error: ${error.message}`;
    }
    throw error;
  }
}

export function buildLoopTicketTools({ userId, loopId }: LoopTicketScope): Record<string, ToolDefinition> {
  let creates = 0;

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
          return {
            loopId: loop.id,
            stages: loop.stages,
            tickets: tickets.data.filter(t => !params.stage || t.stage === params.stage).map(summarize),
            hasMore: tickets.hasMore,
          };
        }),
      toolSchema: {
        name: 'loop_ticket_list',
        description:
          "List the tickets of this loop (or another of the owner's loops by loopId), with their stage and status.",
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
          };
          const loop = await ownLoop(params.loopId ?? loopId);
          if (params.status !== undefined && !['open', 'blocked'].includes(params.status as string)) {
            throw new BadRequestError('status must be one of: open, blocked');
          }
          const title = validateWorkItemTitle(params.title);
          const description = validateWorkItemDescription(params.description);
          const dependencies = validateWorkItemDependencies(params.dependencies) ?? [];
          await assertDependenciesUsable(userId, dependencies);
          const move = ticketMovePatch(loop, undefined, {
            stage: params.stage,
            status: params.status as WorkItemStatus | undefined,
            reason: params.reason,
          });

          creates++;
          const created = await workItemRepository.create({
            userId,
            loopId: loop.id,
            title,
            ...(description ? { description } : {}),
            dependencies,
            stage: move.stage!,
            status: move.status!,
            ...(move.closedAt && { closedAt: move.closedAt }),
            ...(move.statusReason && { statusReason: move.statusReason }),
          } as Omit<IWorkItem, 'id' | 'createdAt' | 'updatedAt'>);
          await makeDueIfReady(loop);
          return summarize(created);
        }),
      toolSchema: {
        name: 'loop_ticket_create',
        description:
          "File a ticket into this loop or another of the owner's loops (by loopId). A ticket starts in the loop's first stage unless a stage is given; the target loop works it on its next run. To file a step only the owner can do (a decision, credentials, a human-only action), set status blocked with a reason: the owner is notified.",
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Short title (300 characters max).' },
            description: { type: 'string', description: 'What needs doing (10,000 characters max).' },
            loopId: { type: 'string', description: 'Target loop. Defaults to the loop this run belongs to.' },
            stage: { type: 'string', description: "One of the target loop's stages. Defaults to its first stage." },
            status: { type: 'string', enum: ['open', 'blocked'], description: 'Defaults to open.' },
            reason: { type: 'string', description: 'Required when status is blocked: what the owner needs to do.' },
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
          };
          const existing =
            typeof params.id === 'string' ? await workItemRepository.findByIdForUser(params.id, userId) : null;
          // A plain work item (no loopId) is the user's own, not a loop's: it reads as missing here.
          if (!existing?.loopId) throw new NotFoundError(TICKET_NOT_FOUND);

          const movesLoop = params.loopId !== undefined && params.loopId !== existing.loopId;
          const loop = await ownLoop(movesLoop ? params.loopId : existing.loopId);
          if (params.status !== undefined && !['open', 'blocked', 'closed'].includes(params.status as string)) {
            throw new BadRequestError('status must be one of: open, blocked, closed');
          }

          const patch = {
            ...(params.title !== undefined && { title: validateWorkItemTitle(params.title) }),
            ...(params.description !== undefined && { description: validateWorkItemDescription(params.description) }),
            ...((movesLoop || params.stage !== undefined || params.status !== undefined) && {
              loopId: loop.id,
              ...ticketMovePatch(loop, movesLoop ? undefined : existing, {
                stage: params.stage,
                status: params.status as WorkItemStatus | undefined,
                reason: params.reason,
              }),
            }),
          };
          // Conditional on the status the patch was computed from, so a concurrent fold is not overwritten.
          const updated = await workItemRepository.updateForUser(existing.id, userId, patch, existing.status);
          if (!updated) throw new ConflictError('ticket changed while saving; list it again and retry');
          await makeDueIfReady(loop);
          return summarize(updated);
        }),
      toolSchema: {
        name: 'loop_ticket_update',
        description:
          "Change a loop ticket: edit it, move it to another stage or another of the owner's loops, block it (with a reason) or close it. Moving a ticket to the last stage closes it.",
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Ticket id.' },
            title: { type: 'string', description: 'New title (300 characters max).' },
            description: { type: 'string', description: 'New description (10,000 characters max).' },
            stage: { type: 'string', description: "One of the loop's stages." },
            status: { type: 'string', enum: ['open', 'blocked', 'closed'], description: 'New status.' },
            reason: { type: 'string', description: 'Required when status is blocked.' },
            loopId: { type: 'string', description: "Move the ticket to another of the owner's loops." },
          },
          required: ['id'],
        },
      },
    }),
  };

  return { loop_ticket_list: list, loop_ticket_create: create, loop_ticket_update: update };
}
