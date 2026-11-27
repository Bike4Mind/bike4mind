import { PeerService } from '../PeerService.js';
import { isPeerIdentity } from '../protocol.js';

let service: PeerService | undefined;
let ready = true;

process.on('message', async (value: unknown) => {
  if (!value || typeof value !== 'object') return;
  const command = value as Record<string, unknown>;
  try {
    let result: unknown;
    switch (command.action) {
      case 'start': {
        if (typeof command.root !== 'string' || !isPeerIdentity(command.identity))
          throw new Error('Invalid fixture identity');
        service = new PeerService({
          root: command.root,
          identity: command.identity,
          canDeliver: () => ready,
          deliver: async text => ({ status: 'completed', text: `fake-result:${text}` }),
        });
        await service.start();
        result = service.identity;
        break;
      }
      case 'list':
        result = await requireService().list();
        break;
      case 'send':
        result = await requireService().send(field(command, 'target'), field(command, 'text'));
        break;
      case 'reply':
        result = await requireService().reply(field(command, 'messageId'), field(command, 'text'));
        break;
      case 'status':
        result = await requireService().status(field(command, 'target'), field(command, 'messageId'));
        break;
      case 'cancel':
        result = await requireService().cancel(field(command, 'target'), field(command, 'messageId'));
        break;
      case 'release':
        await requireService().release(field(command, 'messageId'));
        break;
      case 'inbox':
        result = await requireService().inbox();
        break;
      case 'ready':
        ready = command.ready === true;
        break;
      case 'accept':
        await requireService().setPolicy('accept');
        break;
      case 'budget':
        requireService().resetSendBudget();
        break;
      case 'close':
        await requireService().close();
        break;
      default:
        throw new Error('Unknown fixture action');
    }
    process.send?.({ id: command.id, result });
  } catch (error) {
    process.send?.({ id: command.id, error: error instanceof Error ? error.message : String(error) });
  }
});

process.on('disconnect', () => {
  void service?.close().finally(() => process.exit(0));
});

function requireService(): PeerService {
  if (!service) throw new Error('Fixture service is not started');
  return service;
}

function field(command: Record<string, unknown>, name: string): string {
  if (typeof command[name] !== 'string') throw new Error(`Invalid ${name}`);
  return command[name];
}
