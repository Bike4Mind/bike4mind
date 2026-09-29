import type { ChatToolCall, ChatToolStatus } from '@shared/chat';

/**
 * How each tool is spoken about in the transcript.
 *
 * The rows read as prose ("Ran 3 commands"), but every word of them comes from this table plus
 * the call's own argument - no model round trip writes a summary, because a request and its
 * latency per tool call would be a high price for a label.
 */
interface ToolPhrases {
  /**
   * Past tense, prefixing the call's own argument: "Read" + "src/app.ts". Left out when the
   * argument is prose rather than a name (a generation prompt), where the bare phrase reads
   * better.
   */
  did?: string;
  /** Past tense with nothing to name: "Read a file". */
  didAlone: string;
  /** Infinitive form of `did`, for the statuses where the past tense would claim too much. */
  to?: string;
  /** Infinitive form of `didAlone`. */
  toAlone: string;
  /** Consecutive calls to this tool, collapsed. */
  many: (count: number) => string;
  /** Present tense, for the status line while the call is still running. */
  active: string;
}

const PHRASES: Record<string, ToolPhrases> = {
  file_read: {
    did: 'Read',
    didAlone: 'Read a file',
    to: 'read',
    toAlone: 'read a file',
    many: n => `Read ${n} files`,
    active: 'Reading files...',
  },
  glob_files: {
    did: 'Searched for',
    didAlone: 'Searched for files',
    to: 'search for',
    toAlone: 'search for files',
    many: n => `Ran ${n} file searches`,
    active: 'Searching for files...',
  },
  grep_search: {
    did: 'Searched for',
    didAlone: 'Searched the project',
    to: 'search for',
    toAlone: 'search the project',
    many: n => `Ran ${n} searches`,
    active: 'Searching...',
  },
  bash_execute: {
    did: 'Ran',
    didAlone: 'Ran a command',
    to: 'run',
    toAlone: 'run a command',
    many: n => `Ran ${n} commands`,
    active: 'Running a command...',
  },
  bash_background: {
    did: 'Started',
    didAlone: 'Started a background process',
    to: 'start',
    toAlone: 'start a background process',
    many: n => `Started ${n} background processes`,
    active: 'Starting a background process...',
  },
  bash_output: {
    didAlone: 'Checked background output',
    toAlone: 'check background output',
    many: n => `Checked background output ${n} times`,
    active: 'Checking background output...',
  },
  bash_list: {
    didAlone: 'Listed background processes',
    toAlone: 'list background processes',
    many: n => `Listed background processes ${n} times`,
    active: 'Listing background processes...',
  },
  bash_kill: {
    didAlone: 'Stopped a background process',
    toAlone: 'stop a background process',
    many: n => `Stopped ${n} background processes`,
    active: 'Stopping a background process...',
  },
  file_write: {
    did: 'Wrote',
    didAlone: 'Wrote a file',
    to: 'write',
    toAlone: 'write a file',
    many: n => `Wrote ${n} files`,
    active: 'Writing files...',
  },
  file_edit: {
    did: 'Edited',
    didAlone: 'Edited a file',
    to: 'edit',
    toAlone: 'edit a file',
    many: n => `Edited ${n} files`,
    active: 'Editing files...',
  },
  generate_image: {
    didAlone: 'Generated an image',
    toAlone: 'generate an image',
    many: n => `Generated ${n} images`,
    active: 'Generating an image...',
  },
  generate_speech: {
    didAlone: 'Generated speech',
    toAlone: 'generate speech',
    many: n => `Generated speech ${n} times`,
    active: 'Generating speech...',
  },
  generate_sound_effect: {
    didAlone: 'Generated a sound effect',
    toAlone: 'generate a sound effect',
    many: n => `Generated ${n} sound effects`,
    active: 'Generating a sound effect...',
  },
  session_list: {
    didAlone: 'Listed the sessions in this project',
    toAlone: 'list the sessions in this project',
    many: n => `Listed the sessions ${n} times`,
    active: 'Listing sessions...',
  },
  session_read: {
    didAlone: 'Read another session',
    toAlone: 'read another session',
    many: n => `Read ${n} sessions`,
    active: 'Reading a session...',
  },
  session_spawn: {
    didAlone: 'Started a session',
    toAlone: 'start a session',
    many: n => `Started ${n} sessions`,
    active: 'Starting a session...',
  },
  session_send: {
    didAlone: 'Messaged a session',
    toAlone: 'message a session',
    many: n => `Sent ${n} messages to other sessions`,
    active: 'Sending a message...',
  },
  session_archive: {
    didAlone: 'Archived a session',
    toAlone: 'archive a session',
    many: n => `Archived ${n} sessions`,
    active: 'Archiving a session...',
  },
  session_delete: {
    didAlone: 'Deleted a session',
    toAlone: 'delete a session',
    many: n => `Deleted ${n} sessions`,
    active: 'Deleting a session...',
  },
  generate_music: {
    didAlone: 'Generated music',
    toAlone: 'generate music',
    many: n => `Generated ${n} tracks`,
    active: 'Generating music...',
  },
};

/**
 * A tool this build does not know about - today only possible if main and renderer disagree.
 * Named rather than guessed at: inventing prose for an unknown verb is how a label starts lying.
 */
function unknownPhrases(name: string): ToolPhrases {
  return {
    did: `Ran ${name}`,
    didAlone: `Ran ${name}`,
    to: `run ${name}`,
    toAlone: `run ${name}`,
    many: n => `Ran ${name} ${n} times`,
    active: `Running ${name}...`,
  };
}

function phrasesFor(name: string): ToolPhrases {
  return PHRASES[name] ?? unknownPhrases(name);
}

/**
 * Which argument a search tool is really about.
 *
 * Both take a path AND a pattern, and the generic order below would name the folder - so every
 * search in a session reads as the same row. What was searched FOR is the part that differs.
 */
const ARGUMENT_PRIORITY: Record<string, readonly string[]> = {
  grep_search: ['pattern', 'path'],
  glob_files: ['pattern', 'path'],
  // The title if it was given one, never the seed prompt: that is a paragraph, and a row
  // showing its first 56 characters names the task less well than "Started a session" does.
  session_spawn: ['title'],
};

const DEFAULT_ARGUMENT_PRIORITY: readonly string[] = ['path', 'pattern', 'command', 'prompt', 'text', 'id'];

/** The argument worth showing next to the tool name - almost always what it acted on. */
export function summarizeInput(call: ChatToolCall): string {
  const input = call.input ?? {};
  const keys = [...(ARGUMENT_PRIORITY[call.name] ?? []), ...DEFAULT_ARGUMENT_PRIORITY];
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return '';
}

const MAX_ARGUMENT_CHARS = 56;

/**
 * Fit an argument into one quiet line.
 *
 * A path is cut from the FRONT, keeping the last two segments: the tail is what identifies the
 * file, and a row reading "/Users/someone/very/long/checkout/src/..." names nothing at all.
 * Anything else (a command, a pattern) keeps its head, which is where its meaning is.
 */
export function shortenArgument(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= MAX_ARGUMENT_CHARS) return flat;

  if (flat.includes('/') && !flat.includes(' ')) {
    const segments = flat.split('/').filter(Boolean);
    const tail = segments.slice(-2).join('/');
    if (tail.length <= MAX_ARGUMENT_CHARS) return `.../${tail}`;
  }
  return `${flat.slice(0, MAX_ARGUMENT_CHARS - 3)}...`;
}

/**
 * One call, as its collapsed row reads.
 *
 * A failure and a refusal get the infinitive: "Ran echo x" on a command the user declined says
 * the opposite of what happened, and a row that misreports the one thing it is there to report
 * is worse than no row.
 */
export function toolRowLabel(call: ChatToolCall): string {
  const phrases = phrasesFor(call.name);
  const argument = shortenArgument(summarizeInput(call));

  if (call.status === 'error' || call.status === 'denied') {
    const attempt = phrases.to && argument ? `${phrases.to} ${argument}` : phrases.toAlone;
    return call.status === 'denied' ? `Did not ${attempt}` : `Failed to ${attempt}`;
  }

  // Only on a call that succeeded: the tool writes it in the past tense as the thing it did, so
  // on a failure it would say the opposite of what happened. The failure paths above run first.
  if (call.label) return shortenArgument(call.label);

  return phrases.did && argument ? `${phrases.did} ${argument}` : phrases.didAlone;
}

export interface ToolCallGroup {
  /** The first call's id - stable across the re-renders that settle the rest of the group. */
  id: string;
  name: string;
  calls: ChatToolCall[];
  label: string;
  status: ChatToolStatus;
}

/**
 * Rank used to pick the one status a collapsed group shows.
 *
 * 'awaiting-approval' outranks everything for the same reason it does in the sidebar: it is the
 * only state where the turn is waiting on the user. A failure outranks the successes beside it,
 * so a group never reads as fine because most of it was.
 */
const STATUS_RANK: Record<ChatToolStatus, number> = {
  'awaiting-approval': 5,
  error: 4,
  denied: 3,
  running: 2,
  done: 1,
};

function groupStatus(calls: readonly ChatToolCall[]): ChatToolStatus {
  return calls.reduce<ChatToolStatus>(
    (worst, call) => (STATUS_RANK[call.status] > STATUS_RANK[worst] ? call.status : worst),
    'done'
  );
}

/**
 * Collapse runs of the same tool into one row apiece.
 *
 * Only CONSECUTIVE calls merge: the order is what the model did, and folding together two reads
 * that had a command between them would claim a sequence that never happened.
 *
 * A call waiting at the approval gate is always its own group, in both directions. It blocks the
 * turn and needs an answer, so it must never be hidden inside a count - and the calls around it
 * have already been answered, which is a different thing to say about them.
 */
export function groupToolCalls(calls: readonly ChatToolCall[]): ToolCallGroup[] {
  const groups: ToolCallGroup[] = [];

  for (const call of calls) {
    const open = groups[groups.length - 1];
    const mergeable =
      open !== undefined &&
      open.name === call.name &&
      call.status !== 'awaiting-approval' &&
      open.status !== 'awaiting-approval';

    if (mergeable) {
      open.calls.push(call);
      open.status = groupStatus(open.calls);
      open.label = phrasesFor(open.name).many(open.calls.length);
      continue;
    }

    groups.push({ id: call.id, name: call.name, calls: [call], label: toolRowLabel(call), status: call.status });
  }

  return groups;
}

/** Present tense for the status line, when one tool is the thing being waited on. */
export function activePhrase(name: string): string {
  return phrasesFor(name).active;
}
