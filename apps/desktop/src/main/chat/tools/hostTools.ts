import { suggestBranchName } from '../project/branchName';
import {
  requireString,
  type HostContext,
  type HostSessionView,
  type SpawnPlacement,
  type ToolContext,
  type ToolDefinition,
} from './types';

/**
 * The tools that drive the app itself, rather than the machine or the server.
 *
 * Offered in Code mode only, because every one of them is scoped to a project: they list, read,
 * start and remove conversations inside the calling session's own project and can address
 * nothing outside it. A Chat session has no project, so the family is not declared for one.
 *
 * Three of them change what the user sees and are held at the approval gate. `session_spawn`
 * and `session_send` are gated on cost and autonomy together - each makes a conversation call
 * models and tools with nobody typing - and `session_delete` is gated as irreversible, which
 * additionally means no "always" answer can ever cover it.
 */

/** Nothing here works without a Code session's project binding behind it. */
function requireHost(context: ToolContext): HostContext {
  if (!context.host) {
    throw new Error('Session tools are only available in a Code session, which is grounded in a project.');
  }
  return context.host;
}

/** One row of the listing, as the model reads it. */
function formatSession(view: HostSessionView, callerId: string | undefined): string {
  const parts = [`${view.id}  ${view.title}`];
  parts.push(`status=${view.status}`, `messages=${view.messageCount}`, `updated=${view.updatedAt}`);
  if (view.archived) parts.push('archived');
  if (view.id === callerId) parts.push('this conversation');
  else if (view.spawnedBy === callerId) parts.push('started by you');
  else if (view.spawnedBy) parts.push('started by another session');
  return parts.join('  ');
}

export const sessionList: ToolDefinition = {
  schema: {
    name: 'session_list',
    description:
      'List the conversations in this project, newest first. Returns each one id, title, how ' +
      'many messages it holds, when it was last updated, and whether it is running, waiting on ' +
      'the user, idle or archived. Use it to find a session id before reading or changing one.',
    parameters: {
      type: 'object',
      properties: {
        include_archived: {
          type: 'boolean',
          description: 'Include archived conversations. Defaults to false.',
        },
      },
      additionalProperties: false,
    },
  },
  async run(input, context) {
    const host = requireHost(context);
    const sessions = await host.listSessions({ includeArchived: input.include_archived === true });
    if (sessions.length === 0) return 'No conversations in this project.';
    return sessions.map(view => formatSession(view, context.sessionId)).join('\n');
  },
};

export const sessionRead: ToolDefinition = {
  schema: {
    name: 'session_read',
    description:
      'Read one conversation in this project as plain text: every turn, in order, with the ' +
      'tools each turn ran. Use it to pick up what a session you started concluded. Ids come ' +
      'from session_list or from session_spawn.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'The conversation to read.' },
      },
      required: ['session_id'],
      additionalProperties: false,
    },
  },
  async run(input, context) {
    const host = requireHost(context);
    const transcript = await host.readSession(requireString(input, 'session_id'));
    if (transcript === null) return 'No conversation with that id in this project.';
    return transcript;
  },
};

/**
 * What the model is told when the user answers "Do it here".
 *
 * Emphatically not a refusal, and worded against one: a declined call trains the model to stop
 * and ask what to do instead (see HOST_GUIDANCE), which is the exact opposite of what this
 * answer means. The user has said they want the work done - just in this conversation.
 */
const DO_IT_HERE = [
  'No session was started, and none should be. The user chose to have this done in THIS',
  'conversation instead, by you, now.',
  '',
  'This is not a refusal and there is nothing to ask about: they have already told you what they',
  'want. Get on with the task you were about to hand over, in this turn, using your own tools. Do',
  'not call session_spawn for it again, and do not ask them what they would like instead.',
].join('\n');

const WORKTREE_NOTE =
  'The new session gets its own git worktree on the branch below, beside the project. It cannot ' +
  'disturb this conversation, and both can work at once.';

const LOCAL_NOTE =
  'The new session shares this conversation working directory. Nothing new is checked out, and ' +
  'both sessions edit the same files at the same time.';

export const sessionSpawn: ToolDefinition = {
  schema: {
    name: 'session_spawn',
    description:
      'Start a NEW conversation in this project and set it working on `prompt` straight away. ' +
      'It runs on its own: it does not wait for you, and it reports back into this conversation ' +
      'when it finishes. Use it for a self-contained piece of work that can proceed without this ' +
      'conversation, and give it everything it needs in the prompt - it cannot see what has been ' +
      'said here. It costs credits and the user approves each one, so do not start one ' +
      'speculatively, and never start several to try variations of the same task. ' +
      'When they approve it, the USER chooses where it runs: in this working directory, or in a ' +
      'git worktree of its own on a new branch. You cannot choose and must not assume - so write ' +
      'the prompt so it stands on its own in either, naming files by their path within the ' +
      'repository rather than telling it to carry on with something uncommitted here. They may ' +
      'also answer that they want the work done in this conversation, in which case nothing is ' +
      'started and you do it yourself.',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'The complete, self-contained task for the new conversation to start on.',
        },
        title: { type: 'string', description: 'Optional short name for its sidebar row.' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  approval(input) {
    const prompt = typeof input.prompt === 'string' ? input.prompt : '';
    const title = typeof input.title === 'string' && input.title ? input.title : null;
    return {
      detail: [title ? `New session: ${title}` : 'New session', '', prompt].join('\n'),
      // The prompt is the key, so approving one task never covers the next: two spawns are the
      // same act only if they would go and do the same thing. Which of the options below was
      // chosen is part of what the gate files a standing approval under, so "always start these
      // locally" can never be spent on a worktree.
      key: `session_spawn:${title ?? ''}:${prompt}`,
      choice: {
        options: [
          {
            id: 'worktree',
            label: 'Start with worktree',
            description: WORKTREE_NOTE,
            input: { placement: 'worktree' },
            // Prefilled and editable rather than derived behind the user's back. A worktree is
            // keyed on its branch, so this name is what decides whether the child is isolated at
            // all - a bad guess has to be visible before anything is created, not after.
            field: { name: 'branch', label: 'Branch', value: suggestBranchName(title ?? undefined, prompt) },
          },
          {
            id: 'local',
            label: 'Start locally',
            description: LOCAL_NOTE,
            input: { placement: 'local' },
          },
          {
            id: 'here',
            label: 'Do it here',
            description: 'No new session. This conversation does the work itself.',
            redirect: true,
            note: DO_IT_HERE,
          },
        ],
      },
    };
  },
  async run(input, context) {
    const host = requireHost(context);
    const prompt = requireString(input, 'prompt');
    const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim() : undefined;

    // Set by the approval card and by nothing else - neither property is in the schema above, so
    // a model cannot send one. Absent means no gate was configured at all, and the answer there
    // is the placement that touches nothing: creating a checkout nobody asked for is the worse
    // of the two ways to be wrong.
    const branch = typeof input.branch === 'string' ? input.branch.trim() : '';
    const placement: SpawnPlacement =
      input.placement === 'worktree' && branch ? { kind: 'worktree', branch } : { kind: 'local' };

    const outcome = await host.spawn(prompt, title, placement);
    if (!outcome.ok) throw new Error(outcome.message);
    return [
      `Started session ${outcome.session.id} ("${outcome.session.title}").`,
      placement.kind === 'worktree'
        ? `The user gave it its own worktree on ${placement.branch}, so it is NOT editing the files here and its dependencies are installing there now.`
        : 'The user had it share this working directory, so it is editing the same files you are.',
      'It is running now. You will be told in this conversation WHEN it finishes, but not what',
      'it said - read it with session_read then if you need that. Do not wait for it in this',
      'turn, and do not start another one for the same work.',
    ].join('\n');
  },
};

export const sessionSend: ToolDefinition = {
  schema: {
    name: 'session_send',
    description:
      'Send a message to a conversation that ALREADY EXISTS in this project, and have it run ' +
      'that message as a turn. Ids come from session_list. Use it to answer a session that has ' +
      'asked you something, to correct one you started, or to give a running one more detail - ' +
      'anything where starting a fresh conversation would throw away what that one has already ' +
      'worked out. If it is mid-reply your message runs as its next turn instead. It does NOT ' +
      'reply to you in this turn: finish your answer without waiting for it, and use ' +
      'session_read on its id later if you need what it said. It spends the user credits in ' +
      'that conversation and they approve every message, so send one message saying the whole ' +
      'thing rather than several.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'The existing conversation to send to.' },
        message: {
          type: 'string',
          description:
            'What to say to it. It can see its own history but nothing said here, so carry the ' +
            'context it needs rather than referring to this conversation.',
        },
      },
      required: ['session_id', 'message'],
      additionalProperties: false,
    },
  },
  async approval(input, context) {
    const sessionId = requireString(input, 'session_id');
    const message = requireString(input, 'message');
    const name = (await requireHost(context).describeSession(sessionId)) ?? sessionId;
    return {
      detail: [`Send this to "${name}", and let it run?`, '', message].join('\n'),
      // Target and message together, for session_spawn's reason: approving one message must
      // never cover the next, and the same words to a different conversation are a different act.
      key: `session_send:${sessionId}:${message}`,
    };
  },
  async run(input, context) {
    const host = requireHost(context);
    const sessionId = requireString(input, 'session_id');
    const message = requireString(input, 'message');

    const outcome = await host.sendTo(sessionId, message);
    if (!outcome.ok) throw new Error(outcome.message);

    // The row has to name the conversation, and the id the model passed is a uuid: this call is
    // the only place the title is known.
    context.report?.label(`Messaged @${outcome.title}: ${message}`);
    return [
      `Delivered your message to ${outcome.sessionId} ("${outcome.title}").`,
      outcome.queued
        ? 'It is mid-reply, so your message runs as its next turn once that reply finishes.'
        : 'It is running your message now.',
      'It does NOT answer into this turn. Carry on without it, and use session_read on that id',
      'later if you need what it said. Do not send the same thing again because no reply came.',
    ].join('\n');
  },
};

export const sessionArchive: ToolDefinition = {
  schema: {
    name: 'session_archive',
    description:
      'Archive a conversation in this project, or bring one back. An archived conversation ' +
      'moves to its own section at the bottom of the sidebar; nothing is lost and the user can ' +
      'undo it. Use it to tidy away work that is finished, never to hide a failure.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'The conversation to archive or restore.' },
        archived: { type: 'boolean', description: 'False to bring it back. Defaults to true.' },
      },
      required: ['session_id'],
      additionalProperties: false,
    },
  },
  async approval(input, context) {
    const sessionId = requireString(input, 'session_id');
    const archiving = input.archived !== false;
    const name = (await requireHost(context).describeSession(sessionId)) ?? sessionId;
    return {
      detail: `${archiving ? 'Archive' : 'Restore'} the conversation "${name}"?`,
      key: `session_archive:${archiving}:${sessionId}`,
    };
  },
  async run(input, context) {
    const host = requireHost(context);
    const sessionId = requireString(input, 'session_id');
    const archived = input.archived !== false;
    const updated = await host.setArchived(sessionId, archived);
    if (!updated) return 'No conversation with that id in this project.';
    return `${archived ? 'Archived' : 'Restored'} "${updated.title}".`;
  },
};

export const sessionDelete: ToolDefinition = {
  schema: {
    name: 'session_delete',
    description:
      'Permanently delete a conversation in this project, with its transcript, its attachments ' +
      'and anything it generated. This CANNOT be undone and the user is asked every single ' +
      'time. Prefer session_archive, which is reversible, and only delete when the user has ' +
      'asked for that specific conversation to be deleted.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'The conversation to delete permanently.' },
      },
      required: ['session_id'],
      additionalProperties: false,
    },
  },
  async approval(input, context) {
    const sessionId = requireString(input, 'session_id');
    const name = (await requireHost(context).describeSession(sessionId)) ?? sessionId;
    return {
      detail: `Permanently delete the conversation "${name}", and everything in it? This cannot be undone.`,
      key: `session_delete:${sessionId}`,
      irreversible: true,
    };
  },
  async run(input, context) {
    const host = requireHost(context);
    const sessionId = requireString(input, 'session_id');
    // Refused here rather than relying on the caps: a conversation deleting itself would leave
    // this turn writing its reply into a file that no longer exists.
    if (sessionId === context.sessionId) throw new Error('A conversation cannot delete itself.');
    const deleted = await host.deleteSession(sessionId);
    if (!deleted) return 'No conversation with that id in this project.';
    return 'Deleted it.';
  },
};
