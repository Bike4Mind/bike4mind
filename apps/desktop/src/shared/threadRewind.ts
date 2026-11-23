import type { ChatMessage, ChatToolCall } from './chat';
import { modelEditSummary } from './modelEdit';

/**
 * Rewinding a thread: editing a sent prompt (which drops it and every turn after it) and
 * regenerating the last reply. Shared so main (which does the truncation, see
 * SessionStore.truncateFrom) and the renderer (which draws the actions and the warning) agree on
 * what may be rewound and what the rewind leaves behind.
 */

/** Tools whose success means the turn changed files in the working tree (Fleet reads it too). */
export const EDIT_TOOLS: ReadonlySet<string> = new Set(['file_write', 'file_edit', 'apply_patch']);

/**
 * Shell tools that run a command. Treated as changing things whatever the command was: whether
 * a command wrote is decided at approval time (shellScan) and is not stored on the call, and a
 * warning that is sometimes unneeded beats one that is missing after `rm` or `git commit`.
 */
const SHELL_RUN_TOOLS: ReadonlySet<string> = new Set(['bash_execute', 'bash_background']);

/**
 * Whether a recorded tool call may have changed something on disk that dropping its turn does
 * not undo. A call that errored counts: a shell command can write before it fails. A call that
 * never ran (denied, still awaiting approval, moved to another session) does not.
 */
export function changedThings(call: Pick<ChatToolCall, 'name' | 'status'>): boolean {
  if (call.status !== 'done' && call.status !== 'error' && call.status !== 'running') return false;
  return EDIT_TOOLS.has(call.name) || SHELL_RUN_TOOLS.has(call.name);
}

/** Whether any of these turns ran a tool that changed things; drives the "not undone" warning. */
export function turnsChangedThings(messages: readonly ChatMessage[]): boolean {
  return messages.some(message => (message.toolCalls ?? []).some(changedThings));
}

/**
 * A prompt the user typed, as opposed to text the app wrote in the user role: a relay from
 * another session, an automatic turn, a spawn's seed, a side chat's opening excerpt, or a
 * /clear or /compact marker. Only these can be edited or recalled.
 */
export function isTypedPrompt(message: ChatMessage): boolean {
  return (
    message.role === 'user' &&
    !message.system &&
    !message.relay &&
    !message.automatic &&
    !message.seed &&
    !message.sideChatOf &&
    !message.boundary
  );
}

/**
 * The text the user would retype to send this prompt again: a skill turn stores the expanded
 * SKILL.md body as its content, so it is the invocation that comes back, not the body.
 */
export function typedText(message: ChatMessage): string {
  if (message.skill) return `/${message.skill.name}${message.skill.args ? ` ${message.skill.args}` : ''}`;
  return message.content;
}

/**
 * The notes an edit of this prompt carries over. Only what the renderer attached for the prompt
 * itself (a point-and-edit note: the picked parts and close-up) rides along; main re-resolves an
 * inline-skill note from the new text, and its other notes describe the original turn's moment.
 */
export function carriedNotes(message: ChatMessage): string[] {
  return (message.notes ?? []).filter(note => modelEditSummary([note]) !== null);
}

/** The reply Regenerate would replace: the last message, when it answers a prompt. */
export function regenerableReply(messages: readonly ChatMessage[]): ChatMessage | null {
  const reply = messages[messages.length - 1];
  const prompt = messages[messages.length - 2];
  if (!reply || reply.role !== 'assistant' || !prompt || prompt.role !== 'user' || prompt.boundary) return null;
  return reply;
}

/** The user's sent prompts, newest first, without repeats of the one before; feeds Up-arrow recall. */
export function promptHistory(messages: readonly ChatMessage[]): string[] {
  const history: string[] = [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!isTypedPrompt(message)) continue;
    const text = typedText(message);
    if (!text.trim() || history[history.length - 1] === text) continue;
    history.push(text);
  }
  return history;
}

/**
 * What editing a prompt would cost: nothing (it is the last turn), dropping later turns, or
 * dropping later turns that changed things the drop does not undo.
 */
export type RewindWarning = 'none' | 'later' | 'changes';

/** The warning for editing each typed prompt in the thread, by message id, in one pass from the end. */
export function editWarnings(messages: readonly ChatMessage[]): Map<string, RewindWarning> {
  const warnings = new Map<string, RewindWarning>();
  let changes = false;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (isTypedPrompt(message)) {
      warnings.set(message.id, changes ? 'changes' : index < messages.length - 1 ? 'later' : 'none');
    }
    if (!changes && (message.toolCalls ?? []).some(changedThings)) changes = true;
  }
  return warnings;
}
