import { runHost } from '@bike4mind/model-host';

/** `b4m host <args>`: the same entry as the standalone `b4m-host`, run under the CLI's Node. */
export function handleHostCommand(args: readonly string[]): Promise<number> {
  return runHost(args, { programName: 'b4m host' });
}
