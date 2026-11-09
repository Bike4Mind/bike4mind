/**
 * Wraps the interactive slash-command handler so a command that fails (a config save that was refused, a disk
 * error) prints why and the session goes on; left unhandled, the rejection would end the CLI.
 */
export function reportCommandErrors(
  handler: (command: string, args: string[]) => Promise<void>,
  report: (message: string) => void
): (command: string, args: string[]) => Promise<void> {
  return async (command, args) => {
    try {
      await handler(command, args);
    } catch (error) {
      report(`/${command} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}
