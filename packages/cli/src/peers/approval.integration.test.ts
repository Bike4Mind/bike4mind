import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PeerService } from './PeerService.js';
import type { PeerIdentity } from './protocol.js';
import { callPeer } from './transport.js';
import { createPeerTools } from '../tools/peerTools.js';

let root: string;
let services: PeerService[];
beforeEach(async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), 'b4m-peer-approval-'));
  services = [];
});
afterEach(async () => {
  await Promise.all(services.map(service => service.close()));
  await rm(root, { recursive: true, force: true });
});

async function start(name: string, reusedId?: string): Promise<PeerService> {
  const identity: PeerIdentity = {
    id: reusedId ?? randomUUID(),
    generation: randomUUID(),
    threadId: randomUUID(),
    name,
    accountId: 'profile',
    projectId: 'project',
  };
  const service = new PeerService({
    root,
    identity,
    canDeliver: () => true,
    deliver: async () => ({ status: 'completed', text: 'done' }),
  });
  services.push(service);
  await service.start();
  return service;
}

describe('peer send approval binding', () => {
  it('shows the resolved recipient incarnation and delivers to that identity', async () => {
    const sender = await start('sender');
    const receiver = await start('worker');
    const approve = vi.fn(async () => true);
    const result = await createPeerTools(() => sender, approve)[1].toolFn({ target: 'worker', text: 'approved input' });
    expect(JSON.parse(String(result))).toMatchObject({ ok: true });
    expect(approve).toHaveBeenCalledWith(expect.stringContaining(receiver.identity.id), 'approved input');
    expect(approve).toHaveBeenCalledWith(expect.stringContaining(receiver.identity.generation), 'approved input');
    expect(approve).toHaveBeenCalledWith(expect.stringContaining(receiver.identity.threadId), 'approved input');
    expect(await receiver.inbox()).toHaveLength(1);
  });

  it.each([false, true])('does not redirect approval to a replacement (reused ID: %s)', async reusedId => {
    const sender = await start('sender');
    const original = await start('worker');
    let replacement: PeerService | undefined;
    const tool = createPeerTools(
      () => sender,
      async () => {
        await original.close();
        replacement = await start('worker', reusedId ? original.identity.id : undefined);
        return true;
      }
    )[1];
    const result = await tool.toolFn({ target: 'worker', text: 'only approved for original' });
    expect(JSON.parse(String(result))).toMatchObject({ ok: false });
    expect(await replacement!.inbox()).toEqual([]);
  });

  it('binds reply approval to the sender incarnation of the received message', async () => {
    const sender = await start('sender');
    const receiver = await start('receiver');
    const sent = await sender.send(receiver.identity.id, 'question');
    if (!sent.ok || !sent.receipt) throw new Error('Missing sent receipt');
    let replacement: PeerService | undefined;
    const tool = createPeerTools(
      () => receiver,
      async () => {
        await sender.close();
        replacement = await start('sender', sender.identity.id);
        return true;
      }
    )[1];
    const result = await tool.toolFn({ target: sent.receipt.id, text: 'answer', reply: true });
    expect(JSON.parse(String(result))).toMatchObject({ ok: false });
    expect(await replacement!.inbox()).toEqual([]);
  });

  it('rejects a changed incarnation at the transport boundary as well', async () => {
    const sender = await start('sender');
    const original = await start('worker');
    const approved = original.identity;
    await original.close();
    const replacement = await start('worker', approved.id);
    expect(
      await callPeer(root, sender.identity, replacement.identity.id, { type: 'presence' }, approved)
    ).toMatchObject({ ok: false, error: expect.stringContaining('approved recipient changed') });
  });
});
