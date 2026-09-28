import { requireString, type HostContext, type HostSessionView, type ToolContext, type ToolDefinition } from './types';

/**
 * The tools that drive the app itself, rather than the machine or the server.
 *
 * Offered in Code mode only, because every one of them is scoped to a project: they list, read,
 * start and remove conversations inside the calling session's own project and can address
 * nothing outside it. A Chat session has no project, so the family is not declared for one.
 *
 * Two of them change what the user sees and are held at the approval gate. `session_spawn` is
 * gated on cost and autonomy together - it starts a conversation that will call models and
 * tools with nobody typing - and `session_delete` is gated as irreversible, which additionally
 * means no "always" answer can ever cover it.
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

export const sessionSpawn: ToolDefinition = {
  schema: {
    name: 'session_spawn',
    description:
      'Start a NEW conversation in this project and set it working on `prompt` straight away. ' +
      'It runs on its own: it does not wait for you, and it reports back into this conversation ' +
      'when it finishes. It can read and change exactly the folders you can, and no others. ' +
      'Use it for a self-contained piece of work that can proceed without this conversation, ' +
      'and give it everything it needs in the prompt - it cannot see what has been said here. ' +
      'It costs credits and the user approves each one, so do not start one speculatively, and ' +
      'never start several to try variations of the same task.',
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
      // same act only if they would go and do the same thing.
      key: `session_spawn:${title ?? ''}:${prompt}`,
    };
  },
  async run(input, context) {
    const host = requireHost(context);
    const prompt = requireString(input, 'prompt');
    const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim() : undefined;

    const outcome = await host.spawn(prompt, title);
    if (!outcome.ok) throw new Error(outcome.message);
    return [
      `Started session ${outcome.session.id} ("${outcome.session.title}").`,
      'It is running now. You will be told in this conversation when it finishes; do not wait',
      'for it in this turn, and do not start another one for the same work.',
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
