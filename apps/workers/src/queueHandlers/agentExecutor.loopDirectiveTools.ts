/**
 * Directive tools for loop runs. Every loop run gets `loop_directive_respond` to answer the directives sent
 * to it; a run of a loop with a non-empty `oversees` also gets `loop_oversee_status` and `loop_directive_issue`
 * to read and steer the loops it oversees. None of them can change another loop's goal, tools, schedule or
 * status: a directive is advice the worker sees on its next scheduled run and may push back on.
 *
 * Wired like the ticket tools (`agentExecutor.loopTicketTools.ts`): appended after profile resolution, gated on
 * `execution.loopId` + `EnableLoops`, and pre-approved on headless loop runs in `startAgentExecution`.
 * Directive storage and states: `LoopDirectiveModel` and `LOOP_DIRECTIVE_TRANSITIONS` in `LoopTypes.ts`.
 */
import {
  LOOP_DIRECTIVE_TOOL_NAMES,
  LOOP_DIRECTIVE_INSTRUCTION_MAX,
  LOOP_DIRECTIVE_NOTE_MAX,
  LOOP_DIRECTIVE_REASON_MAX,
  LOOP_DIRECTIVE_TRANSITIONS,
  LOOP_OVERSEER_TOOL_NAMES,
  WORK_ITEM_STATUSES,
  type ILoop,
  type ILoopDirective,
  type LoopDirectiveWorkerOutcome,
} from '@bike4mind/common';
import {
  agentExecutionRepository,
  loopDirectiveRepository,
  loopRepository,
  workItemRepository,
} from '@bike4mind/database';
import type { ToolDefinition } from '@bike4mind/services/llm';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { ConflictError } from '@bike4mind/server-utils/utils/errors';
import { asToolResult, LOOP_NOT_FOUND } from './agentExecutor.loopTicketTools';

/**
 * Counted in the DB by `executionId`, so it holds across continuations.
 * ponytail: count-then-create, so parallel calls in one turn can slip a little past it, and there is no cap
 * on open directives per target. Add an atomic counter on the execution if either is ever seen.
 */
export const MAX_DIRECTIVES_PER_RUN = 5;
const MEMORY_CHARS = 1000;
const TICKET_SCAN_LIMIT = 100;
const BLOCKED_LIMIT = 20;
const RECENT_RUNS = 5;
const RECENT_DIRECTIVES = 10;
const DIRECTIVE_NOT_FOUND = 'directive not found';
const WORKER_OUTCOMES: readonly LoopDirectiveWorkerOutcome[] = ['accepted', 'pushed_back', 'done'];

interface LoopDirectiveScope {
  userId: string;
  loopId: string;
  executionId: string;
}

export interface LoopDirectiveToolContribution {
  loopDirectiveEnabledTools: readonly string[];
  loopDirectiveExternalTools: Record<string, ToolDefinition>;
}

export async function resolveLoopDirectiveTools({
  loopId,
  loopsEnabled,
  userId,
  executionId,
}: {
  loopId?: string;
  loopsEnabled: boolean;
  userId: string;
  executionId: string;
}): Promise<LoopDirectiveToolContribution> {
  if (!loopId || !loopsEnabled) return { loopDirectiveEnabledTools: [], loopDirectiveExternalTools: {} };
  const tools = buildLoopDirectiveTools({ userId, loopId, executionId });
  const oversees = !!(await loopRepository.findByIdAndUserId(loopId, userId))?.oversees?.length;
  const names = oversees ? [...LOOP_DIRECTIVE_TOOL_NAMES, ...LOOP_OVERSEER_TOOL_NAMES] : LOOP_DIRECTIVE_TOOL_NAMES;
  return {
    loopDirectiveEnabledTools: names,
    loopDirectiveExternalTools: Object.fromEntries(names.map(name => [name, tools[name]])),
  };
}

const requiredText = (field: string, value: unknown, max: number): string => {
  if (typeof value !== 'string' || !value.trim()) throw new BadRequestError(`${field} is required`);
  return value.trim().slice(0, max);
};

const directiveSummary = (directive: ILoopDirective) => ({
  id: directive.id,
  instruction: directive.instruction,
  reason: directive.reason,
  state: directive.state,
  createdAt: directive.createdAt,
  replies: directive.replies.map(reply => ({ by: reply.by, outcome: reply.outcome, note: reply.note, at: reply.at })),
});

async function loopStatus(loop: ILoop, userId: string) {
  const [credits, tickets, runs, directives] = await Promise.all([
    agentExecutionRepository.sumCreditsByLoop([loop.id], [loop.sessionId]),
    // ponytail: counts cover the first 100 unclosed tickets; page through if a watched loop ever holds more.
    workItemRepository.listForUser(
      userId,
      { loopId: loop.id, status: WORK_ITEM_STATUSES.filter(status => status !== 'closed') },
      { page: 1, limit: TICKET_SCAN_LIMIT },
      { by: 'createdAt', direction: 'asc' }
    ),
    agentExecutionRepository.listRecentForLoop(loop.id, loop.sessionId, RECENT_RUNS),
    loopDirectiveRepository.listToLoop(userId, loop.id, RECENT_DIRECTIVES),
  ]);
  const ticketCounts: Record<string, Record<string, number>> = {};
  for (const ticket of tickets.data) {
    const byStatus = (ticketCounts[ticket.stage ?? '(none)'] ??= {});
    byStatus[ticket.status] = (byStatus[ticket.status] ?? 0) + 1;
  }
  return {
    loopId: loop.id,
    name: loop.name,
    status: loop.status,
    ...(loop.statusReason && { statusReason: loop.statusReason }),
    intervalMinutes: loop.intervalMinutes,
    lastRunAt: loop.lastRunAt,
    nextRunAt: loop.nextRunAt,
    consecutiveFailures: loop.consecutiveFailures,
    memory: {
      notes: loop.memory.notes.slice(0, MEMORY_CHARS),
      nextAction: loop.memory.nextAction.slice(0, MEMORY_CHARS),
    },
    creditsUsed: credits[loop.id] ?? 0,
    ticketCounts,
    ticketsHasMore: tickets.hasMore,
    blockedTickets: tickets.data
      .filter(ticket => ticket.status === 'blocked')
      .slice(0, BLOCKED_LIMIT)
      .map(ticket => ({ id: ticket.id, title: ticket.title, stage: ticket.stage, statusReason: ticket.statusReason })),
    recentRuns: runs,
    recentDirectives: directives.map(directiveSummary),
  };
}

export function buildLoopDirectiveTools({
  userId,
  loopId,
  executionId,
}: LoopDirectiveScope): Record<string, ToolDefinition> {
  /** A loop this run's loop oversees right now; re-read per call, so an owner edit applies mid-run. */
  const watchedLoop = async (id: unknown): Promise<{ overseer: ILoop; target: ILoop }> => {
    const overseer = await loopRepository.findByIdAndUserId(loopId, userId);
    const target =
      typeof id === 'string' && overseer?.oversees?.includes(id)
        ? await loopRepository.findByIdAndUserId(id, userId)
        : null;
    if (!overseer || !target) throw new NotFoundError(LOOP_NOT_FOUND);
    return { overseer, target };
  };

  const respond: ToolDefinition = {
    name: 'loop_directive_respond',
    implementation: () => ({
      toolFn: async value =>
        asToolResult(async () => {
          const params = (value ?? {}) as { directiveId?: unknown; outcome?: unknown; note?: unknown };
          const directive =
            typeof params.directiveId === 'string'
              ? await loopDirectiveRepository.findByIdForUser(params.directiveId, userId)
              : null;
          if (!directive || directive.loopId !== loopId) throw new NotFoundError(DIRECTIVE_NOT_FOUND);

          const outcome = params.outcome as LoopDirectiveWorkerOutcome;
          if (!WORKER_OUTCOMES.includes(outcome)) {
            throw new BadRequestError(`outcome must be one of: ${WORKER_OUTCOMES.join(', ')}`);
          }
          if (params.note !== undefined && typeof params.note !== 'string') {
            throw new BadRequestError('note must be a string');
          }
          const note = params.note?.trim().slice(0, LOOP_DIRECTIVE_NOTE_MAX);
          if (outcome === 'pushed_back' && !note) throw new BadRequestError('note is required to push back');

          const from = LOOP_DIRECTIVE_TRANSITIONS[outcome];
          if (!from.includes(directive.state)) throw new BadRequestError(`directive is ${directive.state}`);
          const updated = await loopDirectiveRepository.transition(directive.id, userId, from, outcome, {
            by: 'worker',
            outcome,
            ...(note && { note }),
            executionId,
            at: new Date(),
          });
          if (!updated) throw new ConflictError('directive changed while answering; it may have been withdrawn');
          return { id: updated.id, state: updated.state };
        }),
      toolSchema: {
        name: 'loop_directive_respond',
        description:
          'Answer a directive another loop (your overseer) sent to this loop: accepted (you will act on it), pushed_back (you disagree; give your reason in note) or done (it is carried out). A directive is advice: it cannot change your goal, tools or schedule.',
        parameters: {
          type: 'object',
          properties: {
            directiveId: { type: 'string', description: 'The directive id from this run prompt.' },
            outcome: {
              type: 'string',
              enum: [...WORKER_OUTCOMES],
              description:
                'accepted, pushed_back or done; an accepted directive can still move to done or pushed_back.',
            },
            note: { type: 'string', description: 'Required for pushed_back: your reason (1000 characters max).' },
          },
          required: ['directiveId', 'outcome'],
        },
      },
    }),
  };

  const status: ToolDefinition = {
    name: 'loop_oversee_status',
    implementation: () => ({
      toolFn: async value =>
        asToolResult(async () => {
          const params = (value ?? {}) as { loopId?: unknown };
          if (params.loopId !== undefined) {
            const { target } = await watchedLoop(params.loopId);
            return { loops: [await loopStatus(target, userId)] };
          }
          const overseer = await loopRepository.findByIdAndUserId(loopId, userId);
          if (!overseer) throw new NotFoundError(LOOP_NOT_FOUND);
          const targets = await Promise.all(
            (overseer.oversees ?? []).map(id => loopRepository.findByIdAndUserId(id, userId))
          );
          return {
            loops: await Promise.all(
              targets.filter((loop): loop is ILoop => !!loop).map(loop => loopStatus(loop, userId))
            ),
          };
        }),
      toolSchema: {
        name: 'loop_oversee_status',
        description:
          'Read the state of the loops this loop oversees (or one of them by loopId): status, memory, spend, ticket counts by stage and status, blocked tickets, recent runs and the directives sent to it with their replies. Use loop_ticket_list for full ticket detail.',
        parameters: {
          type: 'object',
          properties: { loopId: { type: 'string', description: 'One overseen loop. Defaults to all of them.' } },
        },
      },
    }),
  };

  const issue: ToolDefinition = {
    name: 'loop_directive_issue',
    implementation: () => ({
      toolFn: async value =>
        asToolResult(async () => {
          const params = (value ?? {}) as { loopId?: unknown; instruction?: unknown; reason?: unknown };
          const { overseer, target } = await watchedLoop(params.loopId);
          const instruction = requiredText('instruction', params.instruction, LOOP_DIRECTIVE_INSTRUCTION_MAX);
          const reason = requiredText('reason', params.reason, LOOP_DIRECTIVE_REASON_MAX);
          if ((await loopDirectiveRepository.countByExecution(executionId)) >= MAX_DIRECTIVES_PER_RUN) {
            throw new BadRequestError(`at most ${MAX_DIRECTIVES_PER_RUN} directives can be issued per run`);
          }
          // Not made due now: the worker picks it up on its next scheduled run, so its pacing stays predictable.
          const created = await loopDirectiveRepository.create({
            loopId: target.id,
            userId,
            fromLoopId: overseer.id,
            fromLoopName: overseer.name,
            executionId,
            instruction,
            reason,
            state: 'open',
            replies: [],
          } as Omit<ILoopDirective, 'id' | 'createdAt' | 'updatedAt'>);
          return { id: created.id, loopId: target.id, state: created.state };
        }),
      toolSchema: {
        name: 'loop_directive_issue',
        description:
          'Send a directive to a loop this loop oversees. The worker sees it on its next scheduled run and answers accepted, pushed_back (with a reason) or done; check replies with loop_oversee_status. A directive is advice: it cannot change the worker goal, tools or schedule, and the worker may push back. Do not do the worker job yourself.',
        parameters: {
          type: 'object',
          properties: {
            loopId: { type: 'string', description: 'The overseen loop.' },
            instruction: { type: 'string', description: 'What the worker should do (2000 characters max).' },
            reason: { type: 'string', description: 'Why (1000 characters max).' },
          },
          required: ['loopId', 'instruction', 'reason'],
        },
      },
    }),
  };

  return { loop_directive_respond: respond, loop_oversee_status: status, loop_directive_issue: issue };
}
