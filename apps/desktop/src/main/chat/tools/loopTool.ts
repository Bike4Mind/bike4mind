import { formatLoopInterval, formatLoopUntil, loopStart, type LoopStart, type LoopState } from '@shared/loop';
import type { ToolContext, ToolDefinition } from './types';

export const LOOP_TOOL_NAME = 'loop';

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error(`The "${key}" argument must be a string.`);
  return value;
}

function startRequest(input: Record<string, unknown>, context: ToolContext): LoopStart {
  const loop = context.loop;
  if (!loop) throw new Error('A loop can only be started in a conversation the user is in.');
  if (loop.inRun()) throw new Error('A loop run cannot start another loop.');
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  const request = loopStart(prompt, optionalString(input, 'interval'), optionalString(input, 'until'));
  if ('error' in request) throw new Error(request.error);
  return request;
}

function approvalKey(request: LoopStart): string {
  return `${LOOP_TOOL_NAME}\x00${JSON.stringify(request)}`;
}

function cadence(intervalMs: number | null): string {
  return intervalMs === null
    ? 'model-paced: each run ends with LOOP_NEXT: <interval>'
    : `${formatLoopInterval(intervalMs)} after each run completes`;
}

function describe(state: LoopState): string {
  return [
    `Prompt: ${state.prompt}`,
    `Interval: ${cadence(state.intervalMs)}`,
    `Until: ${state.until === undefined ? 'stopped by the user' : formatLoopUntil(state.until)}`,
    `Status: ${state.phase}${state.nextRunAt === null ? '' : `, next run ${new Date(state.nextRunAt).toLocaleTimeString()}`}`,
    ...(state.error ? [state.error] : []),
    ...(state.notice ? [state.notice] : []),
  ].join('\n');
}

/**
 * The agent's door to the session's /loop. Starting schedules turns nobody will type, so it asks
 * in 'ask' and 'auto' and is never remembered; listing and stopping change nothing the user has
 * not already allowed. The session is always the caller's: the schema has no way to name another.
 */
export const loopTool: ToolDefinition = {
  schema: {
    name: LOOP_TOOL_NAME,
    description: [
      "Start, list or stop this conversation's recurring loop, the same loop the user's /loop command runs.",
      'Use it whenever the user asks for something to repeat ("every hour", "keep checking until 6pm"):',
      'never emulate a schedule with sleep, a shell loop or a background timer.',
      '',
      'start runs `prompt` as a new turn in this conversation, first once the current turn ends and then',
      'again after each run. One loop per conversation: starting replaces the current one. A loop run',
      'cannot start another loop. The user sees the loop in the session and can stop it there.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'list', 'stop'] },
        prompt: {
          type: 'string',
          description: 'For start: the instruction each run receives, or a /skill invocation with its arguments.',
        },
        interval: {
          type: 'string',
          description:
            'For start: delay after each run completes, a whole number with s, m, h or d from 30s to 1d ' +
            '(e.g. 5m, 1h). Omit to choose the next delay at the end of every run.',
        },
        until: {
          type: 'string',
          description:
            'For start: when the loop ends; no run starts at or after it. A local time today (18:00 or 6pm) ' +
            'or an ISO date-time (2026-05-01T09:00, local unless it has an offset), at most 7 days ahead.',
        },
      },
      required: ['action'],
    },
  },

  needsApproval: input => input.action === 'start',

  approval(input, context) {
    const request = startRequest(input, context);
    return {
      detail: [
        'Start a recurring loop in this conversation:',
        `Prompt: ${request.prompt}`,
        `Interval: ${cadence(request.intervalMs)}`,
        `Until: ${request.until === undefined ? 'stopped by you' : formatLoopUntil(request.until)}`,
      ].join('\n'),
      key: approvalKey(request),
      askInAuto: true,
      allowOnce: true,
    };
  },

  async run(input, context) {
    const loop = context.loop;
    if (!loop) throw new Error('Loops are only available in a conversation the user is in.');
    if (input.action === 'list') {
      const state = loop.current();
      return state ? describe(state) : 'No loop in this conversation.';
    }
    if (input.action === 'stop') {
      if (!loop.current()) return 'No loop in this conversation.';
      loop.stop();
      context.report?.label('Stopped the loop');
      return 'Loop stopped. A run already in progress is left to finish.';
    }
    if (input.action !== 'start') throw new Error('The "action" argument must be start, list or stop.');
    const request = startRequest(input, context);
    if (context.approvedKey !== approvalKey(request))
      throw new Error('The loop request changed after approval. Start it again to approve the current deadline.');
    const result = await loop.start(request);
    if (!result.ok) throw new Error(result.error);
    context.report?.label('Started a loop');
    return [
      'Loop started. The first run begins once this turn ends.',
      ...(result.state ? [describe(result.state)] : []),
    ].join('\n');
  },
};
