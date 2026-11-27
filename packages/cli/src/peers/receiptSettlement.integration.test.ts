import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PeerService, type PeerServiceOptions } from './PeerService.js';
import type { PeerIdentity, PeerReceipt, PeerResponse } from './protocol.js';
import * as transport from './transport.js';

let root: string;
const services: PeerService[] = [];
const transports: Array<Awaited<ReturnType<typeof transport.startPeerTransport>>> = [];
const identity = (name: string): PeerIdentity => ({
  id: randomUUID(),
  generation: randomUUID(),
  threadId: randomUUID(),
  name,
  accountId: 'account',
  projectId: 'project',
});
function barrier() {
  let release: () => void = () => {
    throw new Error('Barrier was not initialized');
  };
  const promise = new Promise<void>(resolve => {
    release = resolve;
  });
  return { promise, release: () => release() };
}
async function start(name: string, overrides: Partial<PeerServiceOptions> = {}) {
  const service = new PeerService({
    root,
    identity: identity(name),
    canDeliver: () => true,
    deliver: async () => ({ status: 'completed', text: 'private result' }),
    ...overrides,
  });
  services.push(service);
  await service.start();
  return service;
}
function receipt(response: PeerResponse): PeerReceipt {
  if (!response.ok || !response.receipt) throw new Error('Expected a receipt');
  return response.receipt;
}
const snapshot = (sender: PeerService) =>
  fs.readFile(path.join(root, 'inboxes', `${sender.identity.id}-${sender.identity.generation}.json`), 'utf8');
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(await fs.realpath(tmpdir()), 'b4m-peer-settlement-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(services.splice(0).map(service => service.close()));
  await Promise.all(transports.splice(0).map(peer => peer.close()));
  await fs.rm(root, { recursive: true, force: true });
});

it.each(['deleted', 'archived'] as const)(
  'does not restore content when a legitimate status response arrives after local %s',
  async action => {
    const sender = await start('sender');
    const receiver = await start('receiver');
    const sent = receipt(await sender.send(receiver.identity.id, 'private request'));
    await receiver.release(sent.id);
    await vi.waitFor(async () => expect((await receiver.inbox())[0]?.status).toBe('completed'));
    if (action === 'deleted')
      expect(receipt(await sender.status(receiver.identity.id, sent.id)).status).toBe('completed');
    const original = transport.callPeer;
    const ready = barrier();
    const held = barrier();
    vi.spyOn(transport, 'callPeer').mockImplementation(async (...args) => {
      const response = await original(...args);
      if (args[3].type === 'status') {
        ready.release();
        await held.promise;
      }
      return response;
    });
    const pending = sender.status(receiver.identity.id, sent.id);
    try {
      await ready.promise;
      if (action === 'archived') await receiver.close();
      await sender.remove(sent.id);
      held.release();
      const result = await pending;
      expect(JSON.stringify(result)).not.toContain('private result');
      expect(JSON.stringify(result)).not.toContain('private request');
      if (action === 'deleted') expect(result).toMatchObject({ ok: false });
      else expect(result).toMatchObject({ ok: true, receipt: { id: sent.id, status: 'completed' } });
      expect(await snapshot(sender)).not.toContain('private result');
      expect(await snapshot(sender)).not.toContain('private request');
      await sender.close();
      const resumed = await start('resumed', {
        identity: { ...identity('resumed'), threadId: sender.identity.threadId },
      });
      expect(JSON.stringify(await resumed.inbox())).not.toContain('private result');
      expect(JSON.stringify(await resumed.inbox())).not.toContain('private request');
    } finally {
      held.release();
      await pending;
    }
  }
);

it('does not restore archived content when the original send response arrives late', async () => {
  const sender = await start('sender');
  const target = identity('target');
  const peer = await transport.startPeerTransport({
    root,
    identity: target,
    handle: async (source, request) => {
      if (request.type === 'presence') return { ok: true, presence: { policy: 'hold', ready: true } };
      if (request.type !== 'send') return { ok: false, error: 'unsupported' };
      return {
        ok: true,
        receipt: {
          ...request.message,
          senderId: source.id,
          recipientId: target.id,
          status: 'completed',
          result: 'private result',
        },
      };
    },
  });
  transports.push(peer);
  const original = transport.callPeer;
  const ready = barrier();
  const held = barrier();
  vi.spyOn(transport, 'callPeer').mockImplementation(async (...args) => {
    const response = await original(...args);
    if (args[3].type === 'send') {
      ready.release();
      await held.promise;
    }
    return response;
  });
  const pending = sender.send(target.id, 'private request');
  try {
    await ready.promise;
    const sent = (await sender.inbox())[0];
    if (!sent) throw new Error('Missing in-flight send');
    await peer.close();
    await sender.remove(sent.id);
    held.release();
    const result = receipt(await pending);
    expect(result.status).toBe('completed');
    expect(result.text).toBeUndefined();
    expect(result.result).toBeUndefined();
    expect(await snapshot(sender)).not.toContain('private result');
    expect(await snapshot(sender)).not.toContain('private request');
  } finally {
    held.release();
    await pending;
  }
});

it.each(['createdAt', 'expiresAt', 'hops', 'replyTo'] as const)(
  'rejects a signed receipt that changes immutable %s',
  async field => {
    const sender = await start('sender');
    const target = identity('target');
    const peer = await transport.startPeerTransport({
      root,
      identity: target,
      handle: async (source, request) => {
        if (request.type !== 'send') return { ok: true, presence: { policy: 'hold', ready: true } };
        const mutation = field === 'replyTo' ? 'unrelated' : request.message[field] + 1;
        return {
          ok: true,
          receipt: {
            ...request.message,
            senderId: source.id,
            recipientId: target.id,
            status: 'completed',
            [field]: mutation,
          },
        };
      },
    });
    transports.push(peer);
    expect(receipt(await sender.send(target.id, 'immutable request'))).toMatchObject({
      status: 'unknown',
      error: 'Invalid peer receipt',
    });
  }
);

it.each(['status', 'policy'] as const)(
  'rejects authenticated array-valued %s before it can poison storage',
  async field => {
    const sender = await start('sender');
    const target = identity('target');
    const peer = await transport.startPeerTransport({
      root,
      identity: target,
      handle: async (source, request) => {
        if (request.type === 'presence')
          return (field === 'policy'
            ? { ok: true, presence: { policy: ['hold'], ready: true } }
            : { ok: true, presence: { policy: 'hold', ready: true } }) as unknown as PeerResponse;
        if (request.type !== 'send') return { ok: false, error: 'unsupported' };
        return {
          ok: true,
          receipt: { ...request.message, senderId: source.id, recipientId: target.id, status: ['completed'] },
        } as unknown as PeerResponse;
      },
    });
    transports.push(peer);
    if (field === 'policy')
      expect(await transport.callPeer(root, sender.identity, target.id, { type: 'presence' })).toMatchObject({
        ok: false,
      });
    else {
      expect(await sender.send(target.id, 'request')).toMatchObject({ ok: false });
      expect((await sender.inbox())[0]?.status).toBe('unknown');
      expect(await snapshot(sender)).not.toContain('"status":["completed"]');
    }
  }
);
