import type { PeerService } from '../../peers/PeerService.js';
import type { CommandHandler } from '../types.js';

export interface PeerControls {
  enable(name?: string): Promise<void>;
  disable(): Promise<void>;
  get(): PeerService | null;
}

const usage =
  '/peers on [name] | off | list | send <session-id> <text> | reply <message-id> <text> | inbox | status <session-id> <message-id> | cancel <session-id> <message-id> | accept | hold | refuse | release <message-id> | delete <message-id>';

export const peerCommand: CommandHandler = {
  name: 'peers',
  run: async (args, ctx) => {
    try {
      const controls = ctx.peers;
      if (!controls) throw new Error('Peer messaging is available in the interactive CLI only.');
      const [action, target, ...rest] = args;
      if (action === 'on') {
        await controls.enable(args.slice(1).join(' ') || undefined);
        console.log(
          'Peer messaging enabled with incoming messages held. Use /peers accept to allow idle turns and model usage.'
        );
        return;
      }
      if (action === 'off') {
        await controls.disable();
        console.log('Peer messaging disabled.');
        return;
      }
      const service = controls.get();
      if (!service) throw new Error('Peer messaging is off. Use /peers on [name] to enable it for this session.');
      let output: unknown;
      switch (action) {
        case 'list':
          output = await service.list();
          break;
        case 'inbox':
          output = await service.inbox();
          break;
        case 'send':
          if (!target || !rest.length) throw new Error(usage);
          output = await service.send(target, rest.join(' '), undefined, undefined, { origin: 'human' });
          break;
        case 'reply':
          if (!target || !rest.length) throw new Error(usage);
          output = await service.reply(target, rest.join(' '), undefined, { origin: 'human' });
          break;
        case 'status':
        case 'cancel':
          if (!target || rest.length !== 1) throw new Error(usage);
          output = await service[action](target, rest[0]);
          break;
        case 'accept':
        case 'hold':
        case 'refuse':
          await service.setPolicy(action);
          console.log(
            action === 'accept'
              ? 'Incoming messages may now start idle turns and incur model usage.'
              : `Incoming policy: ${action}.`
          );
          return;
        case 'release':
        case 'delete':
          if (!target || rest.length) throw new Error(usage);
          if (action === 'release') await service.release(target);
          else {
            await service.remove(target);
            console.log('Removed local message content. This does not cancel remote work.');
          }
          output = { messageId: target, action: action === 'release' ? 'approved' : 'deleted' };
          break;
        default:
          throw new Error(usage);
      }
      console.log(JSON.stringify(output, null, 2));
    } catch (error) {
      console.error(error instanceof Error ? error.message : 'Peer command failed.');
    }
  },
};
