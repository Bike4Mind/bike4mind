import type { ToolDefinition, ToolSchema } from './types';

/**
 * A Desktop loop run's ticket and overseer tools. Same names and semantics as the server's (apps/workers/src/queueHandlers/
 * agentExecutor.loopTicketTools.ts) minus hand-offs; the work is done by main/loops/local/ticketTools.ts against
 * the local store. Offered only in a session ChatService marks as a Desktop loop run.
 */

const PRIORITY_PARAM = {
  type: 'string',
  enum: ['p0', 'p1', 'p2', 'p3'],
  description:
    'p0: drop everything, p1: next up, p2: normal, p3: someday. p0 is worked first, p3 last. Without one the ticket waits for a triage run to set it.',
};
const BLOCKED_ON_PARAM = {
  type: 'string',
  enum: ['dependencies'],
  description:
    'With status blocked: park the ticket until every listed dependency closes. It then reopens on its own and the owner is not notified. Needs at least one open dependency.',
};
const DEPENDENCIES_PARAM = { type: 'array', items: { type: 'string' } };

const tool = (name: string, description: string, parameters: ToolSchema['parameters']): ToolDefinition => ({
  schema: { name, description, parameters },
  run(input, context) {
    if (!context.localLoopTickets) throw new Error(`${name} is only available to a loop run.`);
    return context.localLoopTickets.call(name, input);
  },
});

export const LOCAL_LOOP_TICKET_TOOLS: ToolDefinition[] = [
  tool('loop_ticket_list', 'List the tickets of this loop, with their stage and status.', {
    type: 'object',
    properties: {
      stage: { type: 'string', description: 'Only tickets in this stage.' },
      status: {
        type: 'string',
        enum: ['open', 'in_progress', 'blocked', 'closed'],
        description: 'Only tickets with this status.',
      },
    },
  }),
  tool(
    'loop_ticket_create',
    "File a ticket into this loop. It starts in the loop's first stage unless a stage is given. To file a step only the owner can do (a decision, credentials, a human-only action), set status blocked with a reason: the owner is notified. To hold a ticket until other tickets close, list them as dependencies and set status blocked with blockedOn dependencies instead: it reopens on its own and the owner is not notified.",
    {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title (300 characters max).' },
        description: { type: 'string', description: 'What needs doing (10,000 characters max).' },
        stage: { type: 'string', description: "One of the loop's stages. Defaults to its first stage." },
        status: { type: 'string', enum: ['open', 'blocked'], description: 'Defaults to open.' },
        reason: {
          type: 'string',
          description: 'Required when status is blocked without blockedOn: what the owner needs to do.',
        },
        priority: PRIORITY_PARAM,
        blockedOn: BLOCKED_ON_PARAM,
        dependencies: {
          ...DEPENDENCIES_PARAM,
          description: 'Ids of tickets that must close before this one is worked.',
        },
      },
      required: ['title'],
    }
  ),
  tool(
    'loop_ticket_update',
    'Change a loop ticket: edit it, set its priority or dependencies, move it to another stage, block it or close it. Moving a ticket to the last stage closes it. Block with a reason only for something the owner must do: they are notified. To wait on other tickets, set status blocked with blockedOn dependencies: it reopens on its own when they all close and the owner is not notified.',
    {
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
          ...DEPENDENCIES_PARAM,
          description: 'Replaces the ids of tickets that must close before this one is worked.',
        },
      },
      required: ['id'],
    }
  ),
  tool(
    'loop_ticket_unsure',
    'Ask the owner a question when the ticket is ambiguous or needs their decision. Parks the ticket as Unsure until they answer; their answer reaches your next run.',
    {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id of a ticket in this loop.' },
        question: { type: 'string', description: 'What you need the owner to answer (1,000 characters max).' },
      },
      required: ['id', 'question'],
    }
  ),
  tool(
    'loop_ticket_split',
    'Split a ticket too big for one pass through the loop\'s stages into 2-20 child tickets in the same loop. The ticket becomes an epic: it waits on its children and closes on its own once they all close. Give every child a priority. A child may depend on an earlier child by its index ("$0" is the first) or on existing ticket ids.',
    {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id of an open ticket to split.' },
        children: {
          type: 'array',
          description: '2 to 20 child tickets.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Short title (300 characters max).' },
              description: { type: 'string', description: 'What needs doing (10,000 characters max).' },
              stage: { type: 'string', description: "One of the loop's stages. Defaults to its first stage." },
              priority: PRIORITY_PARAM,
              dependencies: {
                ...DEPENDENCIES_PARAM,
                description: 'Earlier children as "$<index>", or existing ticket ids.',
              },
            },
            required: ['title', 'priority'],
          },
        },
      },
      required: ['id', 'children'],
    }
  ),
  ...overseerTools(),
];

/**
 * The overseer tools (main/loops/local/overseerTools.ts), named and shaped as the server's (apps/workers/src/
 * queueHandlers/agentExecutor.loopDirectiveTools.ts). Offered on every Desktop loop run; a loop that oversees
 * nothing gets a refusal, and its prompt never mentions them.
 */
function overseerTools(): ToolDefinition[] {
  const action = (name: string, description: string) =>
    tool(name, description, {
      type: 'object',
      properties: {
        loopId: { type: 'string', description: 'The overseen loop.' },
        reason: { type: 'string', description: 'Why (1000 characters max); shown to the owner in both loop logs.' },
      },
      required: ['loopId', 'reason'],
    });
  return [
    tool(
      'loop_oversee_status',
      'Read the state of the loops this loop oversees (or one of them by loopId): status, why it is idle, memory, spend, ticket counts, blocked tickets, recent runs and the directives sent to it with their replies.',
      {
        type: 'object',
        properties: { loopId: { type: 'string', description: 'One overseen loop. Defaults to all of them.' } },
      }
    ),
    tool(
      'loop_directive_issue',
      'Send a directive to a loop this loop oversees. The worker sees it on its next run and answers accepted, pushed_back (with a reason) or done; check replies with loop_oversee_status. A directive is advice: it cannot change the worker goal or tools, and the worker may push back. Do not do the worker job yourself. At most 5 directives and actions per run.',
      {
        type: 'object',
        properties: {
          loopId: { type: 'string', description: 'The overseen loop.' },
          instruction: { type: 'string', description: 'What the worker should do (2000 characters max).' },
          reason: { type: 'string', description: 'Why (1000 characters max).' },
        },
        required: ['loopId', 'instruction', 'reason'],
      }
    ),
    tool(
      'loop_directive_respond',
      'Answer a directive another loop (your overseer) sent to this loop: accepted (you will act on it), pushed_back (you disagree; give your reason in note) or done (it is carried out). A directive is advice: it cannot change your goal or tools.',
      {
        type: 'object',
        properties: {
          directiveId: { type: 'string', description: 'The directive id from this run prompt.' },
          outcome: {
            type: 'string',
            enum: ['accepted', 'pushed_back', 'done'],
            description: 'accepted, pushed_back or done; an accepted directive can still move to done or pushed_back.',
          },
          note: { type: 'string', description: 'Required for pushed_back: your reason (1000 characters max).' },
        },
        required: ['directiveId', 'outcome'],
      }
    ),
    action(
      'loop_run_now',
      'Start a live loop this loop oversees now, for example a worker idle with ready tickets. Its lanes, budget and pacing still apply. Counts toward the per-run directive cap.'
    ),
    action(
      'loop_resume',
      'Set a loop this loop oversees live again after it stopped in error, once you believe the cause is fixed. Desktop loops have no needs_you status, so error is the only one this resumes; it never resumes a paused loop, and only once per worker per 24 h. Counts toward the per-run directive cap.'
    ),
  ];
}
