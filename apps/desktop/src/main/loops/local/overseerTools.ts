import { randomUUID } from 'node:crypto';
import {
  BadRequestError,
  LOOP_DIRECTIVE_INSTRUCTION_MAX,
  LOOP_DIRECTIVE_NOTE_MAX,
  LOOP_DIRECTIVE_REASON_MAX,
  LOOP_DIRECTIVE_TRANSITIONS,
  type LoopDirectiveAction,
  type LoopDirectiveWorkerOutcome,
} from '@bike4mind/common';
import type { LocalLoop, LocalLoopDirective, LocalLoopSummary } from '@shared/localLoops';
import type { LocalLoopStore } from './LocalLoopStore';
import type { ToolRun } from './ticketTools';

/**
 * Desktop loops overseeing each other: the server's overseer tools (apps/workers/src/queueHandlers/
 * agentExecutor.loopDirectiveTools.ts) against the local store, same names, caps and directive moves. A loop
 * oversees only the Desktop loops in its `oversees`, re-read on every call so an owner edit applies mid-run.
 */
export const OVERSEER_TOOLS = new Set([
  'loop_oversee_status',
  'loop_directive_issue',
  'loop_directive_respond',
  'loop_run_now',
  'loop_resume',
]);

/** As the server: directives plus actions one run may send. */
export const MAX_DIRECTIVES_PER_RUN = 5;
const RESUME_WINDOW_MS = 24 * 60 * 60_000;
const WORKER_OUTCOMES: readonly LoopDirectiveWorkerOutcome[] = ['accepted', 'pushed_back', 'done'];

function requiredText(name: string, value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new BadRequestError(`${name} is required`);
  return value.trim().slice(0, max);
}

const directiveSummary = (directive: LocalLoopDirective) => ({
  id: directive.id,
  instruction: directive.instruction,
  state: directive.state,
  ...(directive.action && { action: directive.action }),
  replies: directive.replies.map(({ by, outcome, note }) => ({ by, outcome, ...(note && { note }) })),
  createdAt: directive.createdAt,
});

/** One overseer tool call; `poke` ticks the scheduler (run now, resume). Throws BadRequestError on a refusal. */
export function overseerTool(
  store: LocalLoopStore,
  run: ToolRun,
  tool: string,
  input: Record<string, unknown>,
  summary: (loop: LocalLoop) => LocalLoopSummary,
  now = new Date()
): unknown {
  const overseer = store.loop(run.loopId);
  if (!overseer) throw new BadRequestError('loop not found');
  const at = now.toISOString();

  const watched = (id: unknown): LocalLoop => {
    if (!overseer.oversees?.length) throw new BadRequestError('This loop oversees no loops.');
    const target = typeof id === 'string' && overseer.oversees.includes(id) ? store.loop(id) : null;
    if (!target) throw new BadRequestError('Loop not found.');
    return target;
  };
  const checkCap = () => {
    if (
      store.directives(overseer.id).filter(directive => directive.runId === run.runId).length >= MAX_DIRECTIVES_PER_RUN
    )
      throw new BadRequestError(`at most ${MAX_DIRECTIVES_PER_RUN} directives can be issued per run`);
  };
  const send = (
    target: LocalLoop,
    fields: Pick<LocalLoopDirective, 'instruction' | 'reason' | 'state'> & { action?: LoopDirectiveAction }
  ) =>
    store.putDirective({
      id: randomUUID(),
      loopId: target.id,
      fromLoopId: overseer.id,
      fromLoopName: overseer.name,
      runId: run.runId,
      replies: [],
      createdAt: at,
      updatedAt: at,
      ...fields,
    });

  switch (tool) {
    case 'loop_oversee_status': {
      const targets =
        input.loopId !== undefined
          ? [watched(input.loopId)]
          : (overseer.oversees ?? []).flatMap(id => store.loop(id) ?? []);
      return {
        loops: targets.map(target => {
          const tickets = store.tickets(target.id);
          const counts: Record<string, number> = {};
          for (const ticket of tickets) counts[ticket.status] = (counts[ticket.status] ?? 0) + 1;
          const { idleReason, spentToday, lanesBusy } = summary(target);
          return {
            id: target.id,
            name: target.name,
            status: target.status,
            ...(idleReason && { idleReason }),
            lanesBusy,
            spentToday,
            memory: {
              notes: target.memory.notes.slice(0, 1000),
              nextAction: target.memory.nextAction.slice(0, 1000),
            },
            ticketCounts: counts,
            blocked: tickets
              .filter(ticket => ticket.status === 'blocked')
              .slice(0, 10)
              .map(({ id, title, stage, statusReason }) => ({ id, title, stage, statusReason })),
            recentRuns: store
              .runs(target.id)
              .slice(0, 5)
              .map(({ model, outcome, stopReason, reason, startedAt, endedAt }) => ({
                model,
                outcome: outcome ?? stopReason ?? (endedAt ? 'ended' : 'running'),
                ...(reason && { reason }),
                startedAt,
              })),
            recentDirectives: store
              .directives(target.id)
              .filter(directive => directive.loopId === target.id)
              .slice(0, 10)
              .map(directiveSummary),
          };
        }),
      };
    }

    case 'loop_directive_issue': {
      const target = watched(input.loopId);
      const instruction = requiredText('instruction', input.instruction, LOOP_DIRECTIVE_INSTRUCTION_MAX);
      const reason = requiredText('reason', input.reason, LOOP_DIRECTIVE_REASON_MAX);
      checkCap();
      // Not run now: the worker sees it on its next run, as on the server.
      const created = send(target, { instruction, reason, state: 'open' });
      return { id: created.id, loopId: target.id, state: created.state };
    }

    case 'loop_run_now': {
      const target = watched(input.loopId);
      const reason = requiredText('reason', input.reason, LOOP_DIRECTIVE_REASON_MAX);
      if (target.status !== 'live')
        throw new BadRequestError(`loop is ${target.status}; only a live loop can be run now`);
      checkCap();
      // The scheduler ticks after every tool call (LocalLoopScheduler.ticketTool), which is "run now" here.
      const logged = send(target, { instruction: 'Run now', reason, state: 'done', action: 'run_now' });
      return {
        id: logged.id,
        loopId: target.id,
        note: 'It starts now if a lane, its budget and pacing allow.',
      };
    }

    case 'loop_resume': {
      const target = watched(input.loopId);
      const reason = requiredText('reason', input.reason, LOOP_DIRECTIVE_REASON_MAX);
      // Desktop loops stop only in `error` (no needs_you status); a paused loop is the owner's call.
      if (target.status !== 'error')
        throw new BadRequestError(`loop is ${target.status}; only an error loop can be resumed`);
      const since = now.getTime() - RESUME_WINDOW_MS;
      if (
        store
          .directives(target.id)
          .some(
            directive =>
              directive.loopId === target.id && directive.action === 'resume' && Date.parse(directive.createdAt) > since
          )
      )
        throw new BadRequestError('already resumed in the last 24 h; leave it to the owner');
      checkCap();
      const { error, ...rest } = target;
      store.putLoop({ ...rest, status: 'live', errorStreak: 0, updatedAt: at });
      const logged = send(target, {
        instruction: `Resume (was error: ${error ?? 'unknown'})`.slice(0, LOOP_DIRECTIVE_INSTRUCTION_MAX),
        reason,
        state: 'done',
        action: 'resume',
      });
      return { id: logged.id, loopId: target.id, status: 'live' };
    }

    case 'loop_directive_respond': {
      const directive = typeof input.directiveId === 'string' ? store.directive(input.directiveId) : null;
      if (!directive || directive.loopId !== overseer.id) throw new BadRequestError('Directive not found.');
      const outcome = input.outcome as LoopDirectiveWorkerOutcome;
      if (!WORKER_OUTCOMES.includes(outcome))
        throw new BadRequestError(`outcome must be one of: ${WORKER_OUTCOMES.join(', ')}`);
      if (input.note !== undefined && typeof input.note !== 'string')
        throw new BadRequestError('note must be a string');
      const note = input.note?.trim().slice(0, LOOP_DIRECTIVE_NOTE_MAX);
      if (outcome === 'pushed_back' && !note) throw new BadRequestError('note is required to push back');
      if (!LOOP_DIRECTIVE_TRANSITIONS[outcome].includes(directive.state))
        throw new BadRequestError(`directive is ${directive.state}`);
      const updated = store.putDirective({
        ...directive,
        state: outcome,
        replies: [...directive.replies, { by: 'worker', outcome, ...(note && { note }), runId: run.runId, at }],
        updatedAt: at,
      });
      return { id: updated.id, state: updated.state };
    }
  }
  throw new BadRequestError(`unknown tool ${tool}`);
}

/** Open directives first, then accepted, oldest first: what the worker's next run is shown. */
export function openDirectivesFor(store: LocalLoopStore, loopId: string, limit: number): LocalLoopDirective[] {
  return store
    .directives(loopId)
    .filter(directive => directive.loopId === loopId && (directive.state === 'open' || directive.state === 'accepted'))
    .sort((a, b) => (a.state === b.state ? a.createdAt.localeCompare(b.createdAt) : a.state === 'open' ? -1 : 1))
    .slice(0, limit);
}
