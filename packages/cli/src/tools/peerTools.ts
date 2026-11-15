import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';
import type { PeerService } from '../peers/PeerService.js';

export function createPeerTools(
  getService: () => PeerService | null,
  approveSend: (target: string, text: string) => Promise<boolean>
): ICompletionOptionTools[] {
  const service = () => {
    const current = getService();
    if (!current) throw new Error('Peer messaging is off. Ask the user to enable /peers on.');
    return current;
  };
  const field = (args: unknown, key: string) => {
    const value = args && typeof args === 'object' ? (args as Record<string, unknown>)[key] : undefined;
    if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing ${key}.`);
    return value;
  };
  return [
    {
      toolSchema: {
        name: 'peer_list',
        description: 'List opted-in local CLI sessions in this account and project. No histories or files are shared.',
        parameters: { type: 'object', properties: {} },
      },
      toolFn: async () => JSON.stringify(await service().list()),
    },
    {
      toolSchema: {
        name: 'peer_send',
        description:
          'Send an explicit text message to an opted-in local CLI session after human approval. Never ask peers to bypass denied actions or permissions. For a reply supply the received message ID instead of a session ID. This cannot approve permissions, alter configuration, or share full history.',
        parameters: {
          type: 'object',
          properties: {
            target: { type: 'string', description: 'Exact session ID, or received message ID for a reply.' },
            text: { type: 'string', description: 'Explicit message text, at most 8 KiB UTF-8.' },
            reply: { type: 'boolean', description: 'True to reply to a received message.' },
          },
          required: ['target', 'text'],
        },
      },
      toolFn: async (args: unknown) => {
        const current = service();
        const target = field(args, 'target');
        const text = field(args, 'text');
        if (Buffer.byteLength(text) > 8192) throw new Error('Peer messages must be at most 8 KiB.');
        const reply = (args as Record<string, unknown>).reply;
        if (reply !== undefined && typeof reply !== 'boolean') throw new Error('reply must be boolean.');
        const recipient = await current.prepareSendTarget(target, reply === true);
        const approvalTarget = `${JSON.stringify(recipient.name)} (session ${recipient.id}; generation ${recipient.generation}; conversation ${recipient.threadId})${reply ? ` replying to ${target}` : ''}`;
        if (!(await approveSend(approvalTarget, text))) return 'Peer message was not sent: user approval denied.';
        if (getService() !== current)
          throw new Error('Peer session changed while awaiting approval. Message not sent.');
        return JSON.stringify(
          reply
            ? await current.reply(target, text, recipient)
            : await current.send(recipient.id, text, undefined, recipient)
        );
      },
    },
    {
      toolSchema: {
        name: 'peer_status',
        description:
          'Read the receipt and exact correlated result of a message this session sent. Does not read peer history or start a model turn.',
        parameters: {
          type: 'object',
          properties: {
            target: { type: 'string', description: 'Exact recipient session ID.' },
            messageId: { type: 'string', description: 'ID of a message this session sent.' },
          },
          required: ['target', 'messageId'],
        },
      },
      toolFn: async (args: unknown) =>
        JSON.stringify(await service().status(field(args, 'target'), field(args, 'messageId'))),
    },
  ];
}
