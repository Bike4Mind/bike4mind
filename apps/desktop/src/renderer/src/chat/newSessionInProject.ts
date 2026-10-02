import type { ChatProject, CreateCodeSessionRequest } from '@shared/chat';

/**
 * What a second session in an existing project starts from: the folder, and nothing else.
 *
 * The sibling is read for its directory alone. Carrying its branch across used to make the
 * group header's "+" start a session already bound to whatever the conversation beside it
 * happened to be on, with the worktree toggle inherited too - so a click that asks for a blank
 * session could answer with a worktree error about a branch the user never picked. Starting
 * unbound is already how every other new Code session begins (see ChatShell.startSession), and
 * the chip row's unset branch state is the prompt to choose one.
 *
 * `contextDirectories` are left behind for the same reason, and one more: they are folders the
 * tools may read, granted for a different conversation. A grant that arrives without being
 * asked for is the one thing here worth not inheriting silently; re-adding one is a click on
 * the chip row.
 */
export function newSessionInProject(sibling: ChatProject): CreateCodeSessionRequest {
  return { directory: sibling.directory };
}
