import { MirrorStore, assertValidDestinationName } from '../../features/mirror/MirrorStore.js';
import { resolveApiEndpoint } from '../../utils/apiUrl.js';
import { sanitizeTerminalText } from '../../utils/sanitizeTerminalText.js';
import type { CommandHandler, CommandContext } from '../types.js';

const usage =
  'Usage: /mirror add <name> <absolute-directory-without-spaces> | status | pause <name> | resume <name> | revoke <name> | pull <name>';

export async function runMirrorCommand(
  args: string[],
  ctx: Pick<CommandContext, 'configStore'>,
  store: MirrorStore = new MirrorStore()
): Promise<string> {
  const [action, name, directory] = args;
  if (action === 'add' && name && directory && args.length === 3) {
    const config = await ctx.configStore.get();
    const endpoint = resolveApiEndpoint(config.apiConfig);
    if (!config.auth?.userId || endpoint.status !== 'configured') {
      throw new Error('Sign in to a configured Bike4Mind service before adding a destination');
    }
    await store.add({ name, directory, accountId: config.auth.userId, apiUrl: endpoint.url });
    return `Added local destination ${sanitizeTerminalText(name)}. Nothing has been copied yet; pulling is not available yet.`;
  }
  if (action === 'status' && args.length === 1) {
    const destinations = await store.list();
    if (!destinations.length) return 'No local mirror destinations configured.';
    return destinations
      .map(
        destination =>
          `${sanitizeTerminalText(destination.name)}: ${destination.paused ? 'paused' : 'configured'}; ${sanitizeTerminalText(destination.directory)}; ` +
          `account ${sanitizeTerminalText(destination.accountId)}; ` +
          'lag: unknown (pulling is not available yet)'
      )
      .join('\n');
  }
  if (name && args.length === 2 && (action === 'pause' || action === 'resume' || action === 'revoke')) {
    assertValidDestinationName(name);
    if (action === 'revoke') await store.revoke(name);
    else await store.pause(name, action === 'pause');
    return `${action === 'revoke' ? 'Revoked' : action === 'pause' ? 'Paused' : 'Resumed'} ${sanitizeTerminalText(name)}.`;
  }
  if (action === 'pull' && name && args.length === 2) {
    assertValidDestinationName(name);
    const destination = (await store.list()).find(entry => entry.name === name);
    if (!destination) throw new Error('Destination not found');
    if (destination.paused) throw new Error('Destination is paused');
    const config = await ctx.configStore.get();
    const endpoint = resolveApiEndpoint(config.apiConfig);
    if (
      destination.accountId !== config.auth?.userId ||
      endpoint.status !== 'configured' ||
      destination.apiUrl !== endpoint.url
    ) {
      throw new Error('Destination belongs to a different account or service');
    }
    throw new Error('Pulling is not available yet.');
  }
  return usage;
}

export const mirrorCommands: CommandHandler[] = [
  {
    name: 'mirror',
    run: async (args, ctx) => {
      console.log(await runMirrorCommand(args, ctx));
    },
  },
];
