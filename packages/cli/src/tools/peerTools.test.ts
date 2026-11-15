import { describe, expect, it, vi } from 'vitest';
import { createPeerTools } from './peerTools.js';
import type { PeerService } from '../peers/PeerService.js';

const recipient = {
  id: 'peer',
  generation: 'generation',
  threadId: 'thread',
  name: 'worker',
  accountId: 'account',
  projectId: 'project',
};
const prepareSendTarget = async () => recipient;

describe('peer tools', () => {
  it('cannot opt in, release messages, approve permissions, or read histories', async () => {
    const tools = createPeerTools(() => null, vi.fn());
    expect(tools.map(tool => tool.toolSchema.name)).toEqual(['peer_list', 'peer_send', 'peer_status']);
    await expect(tools[0].toolFn({})).rejects.toThrow('off');
  });

  it('requires explicit human approval and rechecks the active service afterward', async () => {
    const send = vi.fn();
    let current = { send, prepareSendTarget } as unknown as PeerService | null;
    const deny = vi.fn(async () => false);
    const denied = createPeerTools(() => current, deny)[1];
    expect(await denied.toolFn({ target: 'peer', text: 'hello' })).toContain('denied');
    expect(send).not.toHaveBeenCalled();
    const changed = createPeerTools(
      () => current,
      async () => {
        current = null;
        return true;
      }
    )[1];
    await expect(changed.toolFn({ target: 'peer', text: 'hello' })).rejects.toThrow('changed');
    expect(send).not.toHaveBeenCalled();
  });

  it('validates bytes before prompting and preserves explicit reply routing', async () => {
    const reply = vi.fn(async () => ({ ok: true }));
    const approve = vi.fn(async () => true);
    const tools = createPeerTools(() => ({ reply }) as unknown as PeerService, approve);
    await expect(tools[1].toolFn({ target: 'peer', text: 'x'.repeat(8193) })).rejects.toThrow('8 KiB');
    expect(approve).not.toHaveBeenCalled();
    const stable = { reply, prepareSendTarget } as unknown as PeerService;
    const tool = createPeerTools(() => stable, approve)[1];
    await tool.toolFn({ target: 'message', text: '/compact @private-file', reply: true });
    expect(reply).toHaveBeenCalledWith('message', '/compact @private-file', recipient);
    expect(approve).toHaveBeenCalledWith(
      expect.stringContaining('generation generation; conversation thread'),
      '/compact @private-file'
    );
  });
});
