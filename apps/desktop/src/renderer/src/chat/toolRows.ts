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
  explore: {
    did: 'Explored',
    didAlone: 'Explored the project',
    to: 'explore',
    toAlone: 'explore the project',
    many: n => `Ran ${n} explorations`,
    active: 'Exploring...',
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
  explore: ['question'],
  // The title if it was given one, never the seed prompt: that is a paragraph, and a row
  // showing its first 56 characters names the task less well than "Started a session" does.
  session_spawn: ['title'],
};

const DEFAULT_ARGUMENT_PRIORITY: readonly string[] = ['path', 'pattern', 'command', 'prompt', 'text', 'id'];

/** The argument worth showing next to the tool name - almost always what it acted on. */
/** "1.2s" for a call that recorded its start and end; undefined for older sessions. */
export function toolDuration(call: ChatToolCall): string | undefined {
  if (call.startedAt === undefined || call.endedAt === undefined) return undefined;
  const ms = Math.max(0, call.endedAt - call.startedAt);
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

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

/** Lines added and removed by the writes in a group, once there has been at least one. */
export interface DiffTotals {
  added: number;
  removed: number;
}

export interface ToolCallGroup {
  /** The first call's id - stable across the re-renders that settle the rest of the group. */
  id: string;
  calls: ChatToolCall[];
  label: string;
  /**
   * Beside `label` rather than inside it, because the label is what gets ellipsized: a run of
   * four clauses is longer than the row, and "+9 -2" at the end of it would be the first thing
   * to disappear and the last thing a reader wants to lose.
   */
  diffstat?: DiffTotals;
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

/** One stretch of a group that the phrase table can speak about in a single clause. */
interface ToolSegment {
  name: string;
  calls: ChatToolCall[];
}

/**
 * Whether a call may share a clause with its neighbours.
 *
 * A failure, a refusal and a call still at the gate never do. The `many` phrases are past-tense
 * counts - "Read 3 files" - so folding a failed read into one reports it as having happened,
 * which is the one thing a row must never do. Alone, each of those gets `toolRowLabel`, which
 * has the infinitive forms for exactly this.
 */
function sharesAClause(call: ChatToolCall): boolean {
  return call.status === 'done' || call.status === 'running';
}

/** Consecutive calls to one tool that read the same way, in the order the model made them. */
function toSegments(calls: readonly ChatToolCall[]): ToolSegment[] {
  const segments: ToolSegment[] = [];

  for (const call of calls) {
    const open = segments[segments.length - 1];
    const mergeable =
      open !== undefined &&
      open.name === call.name &&
      sharesAClause(call) &&
      sharesAClause(open.calls[open.calls.length - 1]);

    if (mergeable) open.calls.push(call);
    else segments.push({ name: call.name, calls: [call] });
  }

  return segments;
}

function segmentLabel(segment: ToolSegment): string {
  if (segment.calls.length === 1) return toolRowLabel(segment.calls[0]);
  return phrasesFor(segment.name).many(segment.calls.length);
}

/**
 * Second and later clauses read as a list rather than as sentences of their own: "Ran 7
 * commands, edited ChatService.ts". Only the first character moves - what follows it is a path,
 * a command or a tool's own name, and none of those are this function's to recase.
 */
function continueSentence(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * What a set of calls changed, over the writes in it that LANDED.
 *
 * Undefined when none of them changed a file - which is also what a transcript written before
 * tool calls recorded their diffs gives, so those rows read exactly as they always did.
 */
export function diffTotals(calls: readonly ChatToolCall[]): DiffTotals | undefined {
  let added = 0;
  let removed = 0;
  let wrote = false;

  for (const call of calls) {
    if (!call.diff) continue;
    wrote = true;
    added += call.diff.added;
    removed += call.diff.removed;
  }

  return wrote ? { added, removed } : undefined;
}

/**
 * How many clauses one row may carry.
 *
 * The label has to name every call under it - a row that says less than it hides is not a
 * summary, it is a lid - so a group holds no more parts than its label can spell out. Four is
 * where the line stops reading as a sentence and starts reading as a list nobody finishes.
 */
const MAX_SEGMENTS = 4;

/**
 * Collapse a consecutive run of tool calls into one row apiece.
 *
 * Only CONSECUTIVE calls merge, across tools as well as within one: the order is what the model
 * did, and the row reads as the list of what it did in that order - "Ran 7 commands, edited
 * ChatService.ts +9 -2". Every word of that still comes from the phrase table; composing is
 * joining its clauses with commas, never writing new prose for them.
 *
 * Where a group STOPS, because an unbounded one would fold a two-hundred-round turn into a
 * single line and call that progress:
 *  - at a round boundary, which costs nothing here: the thread already draws one ToolCallList
 *    per round (MessageThread, over replyRounds.roundsOf), so a run never reaches this function
 *    spanning two. Prose between rounds is the narrative's own break and not ours to cross;
 *  - either side of a call waiting at the approval gate, which blocks the turn and must never
 *    be hidden inside a count - and the calls around it have already been answered, which is a
 *    different thing to say about them;
 *  - at MAX_SEGMENTS clauses, so the label never runs out of room to name what it covers.
 */
export function groupToolCalls(calls: readonly ChatToolCall[]): ToolCallGroup[] {
  const groups: ToolCallGroup[] = [];
  let pending: ToolSegment[] = [];

  const flush = () => {
    if (pending.length === 0) return;
    const members = pending.flatMap(segment => segment.calls);
    const clauses = pending.map((segment, index) =>
      index === 0 ? segmentLabel(segment) : continueSentence(segmentLabel(segment))
    );
    const totals = diffTotals(members);
    groups.push({
      id: members[0].id,
      calls: members,
      label: clauses.join(', '),
      ...(totals ? { diffstat: totals } : {}),
      status: groupStatus(members),
    });
    pending = [];
  };

  for (const segment of toSegments(calls)) {
    if (segment.calls[0].status === 'awaiting-approval') {
      flush();
      pending = [segment];
      flush();
      continue;
    }
    if (pending.length === MAX_SEGMENTS) flush();
    pending.push(segment);
  }
  flush();

  return groups;
}

/** Present tense for the status line, when one tool is the thing being waited on. */
export function activePhrase(name: string): string {
  return phrasesFor(name).active;
}
