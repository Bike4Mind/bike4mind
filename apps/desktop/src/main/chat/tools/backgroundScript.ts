/**
 * The extra file descriptor the child watches for its parent's death.
 *
 * 0/1/2 are the command's own stdio, so the watch pipe is 3. It is handed to the child as the
 * READ end of a pipe whose write end only this process holds.
 */
export const PARENT_WATCH_FD = 3;

/**
 * Wrap a user command so its process group dies with this app, whatever kills the app.
 *
 * Graceful shutdown is handled in TypeScript, but no JavaScript runs when main is SIGKILLed,
 * panics, or the machine yanks it - and that is precisely the case that already bit this
 * project, leaving a dev server holding port 3000 for three days. The only teardown that
 * survives it is one living inside the child.
 *
 * So the child blocks reading fd 3. Nothing is ever written to it: the only event it can see
 * is EOF, which the kernel delivers the instant the last write end closes - i.e. when this
 * process exits, for any reason at all. The guard then signals process group 0, which is this
 * command's own group (the spawn is detached, so the group leader is ours and contains the
 * command and everything it spawned), and the whole tree goes down together.
 *
 * Chosen over polling `kill -0 <parent pid>` because it is instant and cannot be fooled by PID
 * reuse handing the parent's number to something else.
 *
 * `exec 3<&-` after the guard starts keeps the descriptor out of the user command's
 * environment: the guard already holds its own dup, and a command that inherited fd 3 could
 * hold the pipe open past its own exit.
 *
 * Two details are load-bearing and were each a bug first:
 *  - The guard's own stdout and stderr go to /dev/null. Inheriting them would keep the pipes
 *    open after the command exited, and Node reports a process as closed only once its stdio
 *    has ended - so a finished command would sit there reported as still running.
 *  - The guard is dismissed from an EXIT trap rather than by a line after the command. A
 *    command ending in an explicit `exit` never reaches that line, and would leave a stray
 *    shell blocked on the pipe for the rest of the app's life.
 *
 * This is lifecycle, not security. The command is arbitrary approved bash and can of course
 * dismantle the guard; the sandbox and the approval gate are what confine it.
 */
export function wrapWithParentWatchdog(command: string): string {
  return [
    `{ IFS= read -r _ <&${PARENT_WATCH_FD}; kill -TERM 0; } >/dev/null 2>&1 &`,
    '__b4m_guard=$!',
    `exec ${PARENT_WATCH_FD}<&-`,
    `trap 'kill "$__b4m_guard" 2>/dev/null' EXIT`,
    '__b4m_status=0',
    '{',
    command,
    '} || __b4m_status=$?',
    'exit "$__b4m_status"',
    '',
  ].join('\n');
}
