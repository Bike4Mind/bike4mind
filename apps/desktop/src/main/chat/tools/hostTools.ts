import { suggestBranchName } from '../project/branchName';
import {
  requireString,
  type HostContext,
  type HostSessionView,
  type SpawnPlacement,
  type SpawnSuggestionHost,
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
 * Three of them change what the user sees and declare an approval. `session_spawn` is gated on
 * cost and autonomy together, asked in every mode including 'full' - starting a conversation
 * that calls models and tools with nobody typing is its own decision - and `session_delete` is
 * gated as irreversible, which additionally means no "always" answer can ever cover it.
 *
 * With a user present, `session_spawn` does not start anything and so is not gated at all: it
 * leaves a suggestion card the user starts, edits or dismisses whenever they like, and the turn
 * carries on. The gate is for the spawned sessions, where nobody is watching a card.
 * `session_send` rides the mode like an ordinary tool: its runaway case is bounded structurally
 * by the relay hop and fan-out budgets, so 'ask' asks and the other modes do not.
 */

/** Nothing here works without a Code session's project binding behind it. */
function requireHost(context: ToolContext): HostContext {
  if (!context.host) {
    throw new Error('Session tools are only available in a Code session, which is grounded in a project.');
  }
  return context.host;
}

function requireSuggestions(context: ToolContext): SpawnSuggestionHost {
  const suggestions = requireHost(context).suggestions;
  if (!suggestions) throw new Error('This conversation has no user present to show a suggestion to.');
  return suggestions;
}

function optionalText(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
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
    const read = await host.readSession(requireString(input, 'session_id'));
    if (read === null) return 'No conversation with that id in this project.';
    if (read.untrusted) context.report?.untrusted();
    return read.transcript;
  },
};

function worktreeNote(base: string): string {
  return (
    `The new session gets its own git worktree on the branch below, cut from ${base} and beside ` +
    'the project. Changes not yet committed here do not go with it. It cannot disturb this ' +
    'conversation, and both can work at once.'
  );
}

const LOCAL_NOTE =
  'The new session shares this conversation working directory. Nothing new is checked out, and ' +
  'both sessions edit the same files at the same time.';

export const sessionSpawn: ToolDefinition = {
  schema: {
    name: 'session_spawn',
    description:
      'Hand a self-contained piece of work to a NEW conversation in this project. With the user ' +
      'present this only SUGGESTS it: a card appears beside their composer where they can edit ' +
      'the prompt, title and branch, then start it or dismiss it. Nothing has started when this ' +
      'returns and the call does not wait for them - carry on or end your turn, and say you ' +
      'suggested the task, not that it is running. You are told on a later turn if they start or ' +
      'dismiss it. If they ask in chat to change the task, use session_suggestion_update on the ' +
      'same id instead of suggesting it again; if they decline it or say to do it here, use ' +
      'session_suggestion_dismiss and do the work yourself. In a session that was itself started ' +
      'by another one, the user is asked to approve the start instead, and the call waits. ' +
      'A started session runs on its own, does not report into your turn, and tells this ' +
      'conversation when it finishes. It cannot see anything said here, so the prompt has to ' +
      'carry the whole task. The USER chooses where it runs: in this working directory, or in a ' +
      'git worktree of its own on a new branch cut from the branch this conversation is on - so ' +
      'name files by their path within the repository rather than telling it to carry on with ' +
      'something uncommitted here. Each one costs credits: never suggest several variations of ' +
      'one task.',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'The complete, self-contained task for the new conversation to start on.',
        },
        title: { type: 'string', description: 'Optional short name for its sidebar row.' },
        summary: {
          type: 'string',
          description: 'Optional one line telling the user what the task is for, shown on the card.',
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  // A suggestion starts nothing, so there is nothing to approve; the gate is for the start itself.
  needsApproval: (_input, context) => !context.host?.suggestions,
  async approval(input, context) {
    // Resolved here, once, and carried to `run` in the option's input: the base the card names
    // is then the base the child is cut from, with no second resolution to disagree with it.
    const base = (await context.host?.spawnBase()) ?? '';
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
            description: worktreeNote(base),
            input: { placement: 'worktree', base },
            // Prefilled and editable rather than derived behind the user's back. A worktree is
            // keyed on its branch, so this name is what decides whether the child is isolated at
            // all - a bad guess has to be visible before anything is created, not after.
            field: {
              name: 'branch',
              label: 'Branch',
              value: suggestBranchName(title ?? undefined, prompt),
              hint: `Based on ${base}`,
            },
          },
          {
            id: 'local',
            label: 'Start locally',
            description: LOCAL_NOTE,
            input: { placement: 'local' },
          },
        ],
      },
    };
  },
  async run(input, context) {
    const host = requireHost(context);
    const prompt = requireString(input, 'prompt');
    const title = optionalText(input, 'title');

    if (host.suggestions) {
      const summary = optionalText(input, 'summary');
      const suggestion = await host.suggestions.suggest({
        prompt,
        ...(title ? { title } : {}),
        ...(summary ? { summary } : {}),
      });
      context.report?.label(`Suggested a task: ${suggestion.title}`);
      return [
        `Suggested task ${suggestion.id} ("${suggestion.title}"). Nothing has started.`,
        'It is on a card beside the user composer. They can edit it, start it - in a worktree on',
        `${suggestion.branch} cut from ${suggestion.base}, or in this working directory - or dismiss it.`,
        'Do not wait for them: carry on or end your turn, and tell them you suggested it, not that it',
        `is running. If they ask for changes, call session_suggestion_update with id ${suggestion.id};`,
        'if they decline it or want it done here, call session_suggestion_dismiss and do it yourself.',
        'You will be told on a later turn if they start or dismiss it.',
      ].join('\n');
    }

    // Set by the approval card and by nothing else - none of these properties is in the schema
    // above, so a model cannot send one. Absent means no gate was configured at all, and the
    // answer there is the placement that touches nothing: creating a checkout nobody asked for is
    // the worse of the two ways to be wrong.
    const branch = typeof input.branch === 'string' ? input.branch.trim() : '';
    const worktree = input.placement === 'worktree' && branch !== '';
    // Only empty when no card ran to resolve it, and then resolved the same way the card would.
    const carried = typeof input.base === 'string' ? input.base.trim() : '';
    const base = worktree ? carried || (await host.spawnBase()) : '';
    const placement: SpawnPlacement = worktree ? { kind: 'worktree', branch, base } : { kind: 'local' };

    context.beginWrite?.();
    if (placement.kind === 'worktree') context.report?.progress(`Creating branch ${placement.branch} and worktree...`);
    const outcome = await host.spawn(prompt, title, placement);
    if (!outcome.ok) throw new Error(outcome.message);
    context.report?.label(`Started a session: ${outcome.session.title}`);
    return [
      `Started session ${outcome.session.id} ("${outcome.session.title}").`,
      placement.kind === 'worktree'
        ? `The user gave it its own worktree on ${placement.branch}, cut from ${placement.base}, so it is NOT editing the files here and its dependencies are installing there now.`
        : 'The user had it share this working directory, so it is editing the same files you are.',
      'It is running now. You will be told in this conversation WHEN it finishes, but not what',
      'it said - read it with session_read then if you need that. Do not wait for it in this',
      'turn, and do not start another one for the same work.',
    ].join('\n');
  },
};

export const sessionSuggestionUpdate: ToolDefinition = {
  schema: {
    name: 'session_suggestion_update',
    description:
      'Revise a task you suggested with session_spawn that the user has not started yet, when ' +
      'they ask in chat to add to it, narrow it or rename it. Pass only what changes; `prompt` ' +
      'replaces the whole prompt, so send the complete revised task. Their card updates in place. ' +
      'Use this instead of calling session_spawn again for the same work.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The suggestion id session_spawn returned.' },
        prompt: { type: 'string', description: 'The complete revised task.' },
        title: { type: 'string', description: 'A new short name.' },
        summary: { type: 'string', description: 'A new one-line summary for the card.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  async run(input, context) {
    const suggestions = requireSuggestions(context);
    const id = requireString(input, 'id');
    const prompt = optionalText(input, 'prompt');
    const title = optionalText(input, 'title');
    const summary = optionalText(input, 'summary');
    if (!prompt && !title && !summary) throw new Error('Pass at least one of prompt, title or summary to change.');

    const outcome = await suggestions.update(id, {
      ...(prompt ? { prompt } : {}),
      ...(title ? { title } : {}),
      ...(summary ? { summary } : {}),
    });
    if (!outcome.ok) throw new Error(outcome.message);
    context.report?.label(`Updated the suggested task: ${outcome.suggestion.title}`);
    return `Updated suggestion ${id} ("${outcome.suggestion.title}"). The user sees the new version on its card; it has still not started.`;
  },
};

export const sessionSuggestionDismiss: ToolDefinition = {
  schema: {
    name: 'session_suggestion_dismiss',
    description:
      'Withdraw a task you suggested with session_spawn that the user has not started, when they ' +
      'decline it, say to do it here instead, or it no longer applies. Its card disappears.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The suggestion id session_spawn returned.' },
        reason: { type: 'string', description: 'Optional short reason, shown on the call row.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  async run(input, context) {
    const suggestions = requireSuggestions(context);
    const id = requireString(input, 'id');
    const outcome = await suggestions.dismiss(id);
    if (!outcome.ok) throw new Error(outcome.message);
    const reason = optionalText(input, 'reason');
    context.report?.label(`Withdrew the suggested task: ${outcome.suggestion.title}${reason ? ` (${reason})` : ''}`);
    return `Dismissed suggestion ${id} ("${outcome.suggestion.title}"). Nothing was started.`;
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
      'that conversation and one turn may only send a couple of messages, so send one message ' +
      'saying the whole thing rather than several.',
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
      // Only 'ask' reaches this card, but the key still has to be exact there: approving one
      // message must never cover the next, and the same words to a different conversation are a
      // different act.
      key: `session_send:${sessionId}:${message}`,
    };
  },
  async run(input, context) {
    const host = requireHost(context);
    const sessionId = requireString(input, 'session_id');
    const message = requireString(input, 'message');

    context.beginWrite?.();
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
    context.beginWrite?.();
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
    context.beginWrite?.();
    const deleted = await host.deleteSession(sessionId);
    if (!deleted) return 'No conversation with that id in this project.';
    return 'Deleted it.';
  },
};
