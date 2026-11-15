import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PeerService } from './PeerService.js';
import type { PeerDeliveryResult, PeerServiceOptions } from './PeerService.js';
import type { PeerIdentity, PeerReceipt } from './protocol.js';
import { callPeer } from './transport.js';

let root: string;
let services: PeerService[];

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'b4m-peer-service-'));
  services = [];
});

afterEach(async () => {
  await Promise.all(services.map(service => service.close()));
  await fs.rm(root, { recursive: true, force: true });
});

async function start(name: string, overrides: Partial<PeerServiceOptions> = {}): Promise<PeerService> {
  const service = new PeerService({
    root,
    identity: identity(name),
    canDeliver: () => true,
    deliver: async () => ({ status: 'completed', text: 'done' }),
    ...overrides,
  });
  await service.start();
  services.push(service);
  return service;
}

function identity(name: string): PeerIdentity {
  return {
    id: randomUUID(),
    generation: randomUUID(),
    threadId: randomUUID(),
    name,
    accountId: 'local-profile',
    projectId: 'repository',
  };
}

function receipt(response: Awaited<ReturnType<PeerService['send']>>): PeerReceipt {
  if (!response.ok || !response.receipt) throw new Error(JSON.stringify(response));
  return response.receipt;
}

describe('PeerService', () => {
  it('discovers independent receivers and requires local release before starting work', async () => {
    const deliver = vi.fn(async (): Promise<PeerDeliveryResult> => ({ status: 'completed', text: 'exact result' }));
    const sender = await start('sender');
    const receiver = await start('receiver', { deliver });
    expect(await sender.list()).toEqual([{ ...receiver.identity, presence: { policy: 'hold', ready: true } }]);
    const sent = receipt(await sender.send(receiver.identity.id, '/compact @local-secret.txt'));
    expect(sent.status).toBe('held');
    expect(deliver).not.toHaveBeenCalled();
    await receiver.release(sent.id);
    await vi.waitFor(async () =>
      expect(receipt(await sender.status(receiver.identity.id, sent.id))).toMatchObject({
        status: 'completed',
        result: 'exact result',
      })
    );
    expect(deliver).toHaveBeenCalledExactlyOnceWith('/compact @local-secret.txt', {
      messageId: sent.id,
      senderId: sender.identity.id,
      senderName: 'sender',
      replyTo: undefined,
    });
  });

  it('queues while busy, serializes deliveries, and never overlaps recipient turns', async () => {
    let ready = false;
    let complete: ((value: PeerDeliveryResult) => void) | undefined;
    const deliver = vi.fn(
      () =>
        new Promise<PeerDeliveryResult>(resolve => {
          complete = resolve;
        })
    );
    const sender = await start('sender');
    const receiver = await start('receiver', { canDeliver: () => ready, deliver });
    await receiver.setPolicy('accept');
    const first = receipt(await sender.send(receiver.identity.id, 'first'));
    const second = receipt(await sender.send(receiver.identity.id, 'second'));
    expect(first.status).toBe('queued');
    expect(deliver).not.toHaveBeenCalled();
    ready = true;
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    expect(receipt(await sender.status(receiver.identity.id, second.id)).status).toBe('queued');
    complete?.({ status: 'completed', text: 'first answer' });
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
    complete?.({ status: 'cancelled' });
    await vi.waitFor(async () =>
      expect(receipt(await sender.status(receiver.identity.id, second.id)).status).toBe('cancelled')
    );
    expect(receipt(await sender.status(receiver.identity.id, first.id)).result).toBe('first answer');
  });

  it('deduplicates accepted requests and rejects changed-content IDs and unrelated receipt access', async () => {
    const sender = await start('sender');
    const receiver = await start('receiver');
    const stranger = await start('stranger');
    const sent = receipt(await sender.send(receiver.identity.id, 'one request'));
    const message = {
      id: sent.id,
      text: sent.text!,
      createdAt: sent.createdAt,
      expiresAt: sent.expiresAt,
      hops: sent.hops,
    };
    expect(receipt(await callPeer(root, sender.identity, receiver.identity.id, { type: 'send', message })).id).toBe(
      sent.id
    );
    expect(
      await callPeer(root, sender.identity, receiver.identity.id, {
        type: 'send',
        message: { ...message, text: 'changed' },
      })
    ).toMatchObject({ ok: false });
    expect(
      await callPeer(root, stranger.identity, receiver.identity.id, { type: 'status', messageId: sent.id })
    ).toMatchObject({ ok: false });
    expect(
      await callPeer(root, stranger.identity, receiver.identity.id, { type: 'cancel', messageId: sent.id })
    ).toMatchObject({ ok: false });
    expect((await receiver.inbox()).filter(item => item.id === sent.id)).toHaveLength(1);
  });

  it('withdraws only pending input and deletes content without losing deduplication', async () => {
    const sender = await start('sender');
    const receiver = await start('receiver');
    const sent = receipt(await sender.send(receiver.identity.id, 'private text'));
    expect(receipt(await sender.cancel(receiver.identity.id, sent.id)).status).toBe('cancelled');
    await receiver.remove(sent.id);
    expect(await receiver.inbox()).toEqual([]);
    const duplicate = receipt(
      await callPeer(root, sender.identity, receiver.identity.id, {
        type: 'send',
        message: {
          id: sent.id,
          text: 'private text',
          createdAt: sent.createdAt,
          expiresAt: sent.expiresAt,
          hops: 0,
        },
      })
    );
    expect(duplicate.status).toBe('cancelled');
    expect(duplicate.text).toBeUndefined();
  });

  it('expires pending messages without starting a model and retains terminal receipts for seven days', async () => {
    let now = Date.now();
    const deliver = vi.fn();
    const sender = await start('sender', { now: () => now });
    const receiver = await start('receiver', { now: () => now, deliver });
    const sent = receipt(await sender.send(receiver.identity.id, 'expires'));
    now += 15 * 60 * 1000;
    expect(receipt(await sender.status(receiver.identity.id, sent.id)).status).toBe('expired');
    expect(deliver).not.toHaveBeenCalled();
    now += 7 * 24 * 60 * 60 * 1000;
    expect(await receiver.inbox()).toEqual([]);
  });

  it('recovers pending messages held and does not automatically replay them', async () => {
    const sender = await start('sender');
    const deliver = vi.fn(async (): Promise<PeerDeliveryResult> => ({ status: 'completed' }));
    const receiver = await start('receiver', { canDeliver: () => false, deliver });
    await receiver.setPolicy('accept');
    const sent = receipt(await sender.send(receiver.identity.id, 'recover'));
    await receiver.close();
    const recovered = await start('receiver', { identity: receiver.identity, deliver });
    expect(recovered.getPolicy()).toBe('hold');
    expect((await recovered.inbox())[0]).toMatchObject({ id: sent.id, status: 'held' });
    expect(deliver).not.toHaveBeenCalled();
    await recovered.release(sent.id);
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
  });

  it('records ambiguous interrupted execution as unknown instead of replaying it', async () => {
    const sender = await start('sender');
    let finish: ((value: PeerDeliveryResult) => void) | undefined;
    const receiver = await start('receiver', {
      deliver: () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    });
    await receiver.setPolicy('accept');
    const sent = receipt(await sender.send(receiver.identity.id, 'run once'));
    await vi.waitFor(async () =>
      expect(receipt(await sender.status(receiver.identity.id, sent.id)).status).toBe('delivered')
    );
    await receiver.close();
    const deliver = vi.fn();
    const recovered = await start('receiver', { identity: receiver.identity, deliver });
    expect((await recovered.inbox())[0]).toMatchObject({ id: sent.id, status: 'unknown' });
    expect(deliver).not.toHaveBeenCalled();
    finish?.({ status: 'completed' });
  });

  it('correlates replies and enforces hop limits rather than resetting a peer-origin chain', async () => {
    const sender = await start('sender');
    const receiver = await start('receiver');
    const first = receipt(await sender.send(receiver.identity.id, 'question'));
    const answer = receipt(await receiver.reply(first.id, 'answer'));
    expect(answer).toMatchObject({ replyTo: first.id, hops: 1 });
    let current = answer;
    for (let hops = 2; hops <= 5; hops++) {
      const author = hops % 2 === 0 ? sender : receiver;
      author.resetSendBudget();
      current = receipt(await author.reply(current.id, `reply ${hops}`));
      expect(current.hops).toBe(hops);
    }
    sender.resetSendBudget();
    expect(await sender.reply(current.id, 'loop')).toMatchObject({
      ok: false,
      error: expect.stringContaining('hop limit'),
    });
  });

  it('bounds sends, payload size, and inbound refusal', async () => {
    const sender = await start('sender');
    const receiver = await start('receiver');
    expect(await sender.send(receiver.identity.id, '\u00e9'.repeat(4097))).toMatchObject({ ok: false });
    await sender.send(receiver.identity.id, 'one');
    await sender.send(receiver.identity.id, 'two');
    expect(await sender.send(receiver.identity.id, 'three')).toMatchObject({
      ok: false,
      error: expect.stringContaining('limit'),
    });
    sender.resetSendBudget();
    await receiver.setPolicy('refuse');
    expect(await sender.send(receiver.identity.id, 'refused')).toMatchObject({ ok: false });
  });

  it('hides different scopes and refuses cross-scope delivery', async () => {
    const sender = await start('sender');
    const receiver = await start('receiver', { identity: { ...identity('receiver'), accountId: 'another-account' } });
    expect(await sender.list()).toEqual([]);
    expect(await sender.send(receiver.identity.id, 'cross account')).toMatchObject({ ok: false });
  });

  it('pauses already approved pending input and cancels remote input before hiding sent content', async () => {
    let ready = false;
    const deliver = vi.fn(async (): Promise<PeerDeliveryResult> => ({ status: 'completed' }));
    const sender = await start('sender');
    const receiver = await start('receiver', { canDeliver: () => ready, deliver });
    await receiver.setPolicy('accept');
    const sent = receipt(await sender.send(receiver.identity.id, 'pause me'));
    await receiver.setPolicy('hold');
    ready = true;
    expect(receipt(await sender.status(receiver.identity.id, sent.id)).status).toBe('held');
    expect(deliver).not.toHaveBeenCalled();
    await sender.remove(sent.id);
    expect(
      receipt(await callPeer(root, sender.identity, receiver.identity.id, { type: 'status', messageId: sent.id }))
        .status
    ).toBe('cancelled');
    expect(await sender.inbox()).toEqual([]);
  });

  it('refuses release after the authenticated sender disconnects and refuses controls after close', async () => {
    const sender = await start('sender');
    const receiver = await start('receiver');
    const sent = receipt(await sender.send(receiver.identity.id, 'still held'));
    await sender.close();
    await expect(receiver.release(sent.id)).rejects.toThrow('disconnected');
    await receiver.close();
    await expect(receiver.setPolicy('accept')).rejects.toThrow('not enabled');
    await expect(receiver.release(sent.id)).rejects.toThrow('not enabled');
    await expect(receiver.remove(sent.id)).rejects.toThrow('not enabled');
  });

  it('shows only retired histories of the same saved thread and allows historical content deletion', async () => {
    const sender = await start('sender');
    const receiver = await start('receiver');
    const sent = receipt(await sender.send(receiver.identity.id, 'historical text'));
    const differentThread = await start('different-thread');
    expect(await differentThread.inbox()).toEqual([]);
    await expect(
      start('same-thread', { identity: { ...identity('same-thread'), threadId: receiver.identity.threadId } })
    ).rejects.toThrow();
    await receiver.close();
    const recovered = await start('new-incarnation', {
      identity: { ...identity('new-incarnation'), threadId: receiver.identity.threadId },
    });
    expect((await recovered.inbox())[0]).toMatchObject({ id: sent.id, status: 'unknown', text: 'historical text' });
    await recovered.remove(sent.id);
    expect((await recovered.inbox())[0]).toMatchObject({ id: sent.id, status: 'unknown' });
    expect((await recovered.inbox())[0]?.text).toBeUndefined();
  });

  it('cannot reset an active reply chain using an older message from the same peer', async () => {
    const sender = await start('sender');
    let oldMessageId = '';
    let maliciousReply: Awaited<ReturnType<PeerService['send']>> | undefined;
    const receiver: PeerService = await start('receiver', {
      deliver: async () => {
        maliciousReply = await receiver.reply(oldMessageId, 'reset chain');
        return { status: 'completed' };
      },
    });
    oldMessageId = receipt(await sender.send(receiver.identity.id, 'older message')).id;
    const current = receipt(await sender.send(receiver.identity.id, 'current message'));
    await receiver.release(current.id);
    await vi.waitFor(() =>
      expect(maliciousReply).toMatchObject({ ok: false, error: expect.stringContaining('active message chain') })
    );
  });

  it('fails closed on a durable write error before executing an admitted request', async () => {
    const sender = await start('sender');
    const deliver = vi.fn();
    const receiver = await start('receiver', { deliver });
    await receiver.setPolicy('accept');
    const file = path.join(root, 'inboxes', `${receiver.identity.id}-${receiver.identity.generation}.json`);
    await fs.chmod(file, 0o644);
    expect(await sender.send(receiver.identity.id, 'not durable')).toMatchObject({ ok: false });
    expect(deliver).not.toHaveBeenCalled();
    await fs.chmod(file, 0o600);
    expect(await sender.send(receiver.identity.id, 'still stopped')).toMatchObject({ ok: false });
    expect(deliver).not.toHaveBeenCalled();
  });

  it('bounds accepted bursts per sender and total pending inbox depth', async () => {
    const receiver = await start('receiver');
    const senders = await Promise.all([start('first'), start('second'), start('third')]);
    for (const sender of senders.slice(0, 2)) {
      for (let index = 0; index < 10; index++) {
        sender.resetSendBudget();
        expect(receipt(await sender.send(receiver.identity.id, `message ${index}`)).status).toBe('held');
      }
      if (sender === senders[0]) {
        sender.resetSendBudget();
        expect(await sender.send(receiver.identity.id, 'sender overflow')).toMatchObject({
          ok: false,
          error: expect.stringContaining('rate limit'),
        });
      }
    }
    expect(await senders[2]!.send(receiver.identity.id, 'inbox overflow')).toMatchObject({
      ok: false,
      error: expect.stringContaining('inbox is full'),
    });
    expect(await receiver.inbox()).toHaveLength(20);
  });

  it('bounds result bytes while preserving UTF-8 and persists the exact failure outcome', async () => {
    const sender = await start('sender');
    const receiver = await start('receiver', {
      deliver: async () => ({ status: 'failed', text: '\u00e9'.repeat(12_000), error: 'specific failure' }),
    });
    const sent = receipt(await sender.send(receiver.identity.id, 'bounded answer'));
    await receiver.release(sent.id);
    await vi.waitFor(async () => {
      const result = receipt(await sender.status(receiver.identity.id, sent.id));
      expect(result.status).toBe('failed');
      expect(result.error).toBe('specific failure');
      expect(Buffer.byteLength(result.result ?? '')).toBeLessThanOrEqual(16 * 1024);
      expect(result.result).not.toContain('\uFFFD');
      expect(result.result?.endsWith('...')).toBe(true);
    });
  });

  it('does not infer remote expiry from a stale queued sender receipt or hide running work', async () => {
    let now = Date.now();
    let finish: ((result: PeerDeliveryResult) => void) | undefined;
    const sender = await start('sender', { now: () => now });
    const receiver = await start('receiver', {
      now: () => now,
      deliver: () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    });
    await receiver.setPolicy('accept');
    const sent = receipt(await sender.send(receiver.identity.id, 'long-running request'));
    expect(sent.status).toBe('queued');
    await vi.waitFor(async () => expect((await receiver.inbox())[0]?.status).toBe('delivered'));
    now += 15 * 60 * 1000;
    expect((await sender.inbox())[0]).toMatchObject({ id: sent.id, status: 'unknown' });
    await expect(sender.remove(sent.id)).rejects.toThrow('Reconcile unknown');
    expect((await receiver.inbox())[0]?.status).toBe('delivered');
    now += 7 * 24 * 60 * 60 * 1000;
    const unresolved = (await sender.inbox())[0];
    expect(unresolved).toMatchObject({ id: sent.id, status: 'unknown' });
    expect(unresolved?.text).toBeUndefined();
    await expect(sender.remove(sent.id)).rejects.toThrow('Reconcile unknown');
    finish?.({ status: 'completed', text: 'exact long-running result' });
    await vi.waitFor(async () =>
      expect(receipt(await sender.status(receiver.identity.id, sent.id))).toMatchObject({
        status: 'completed',
        result: 'exact long-running result',
      })
    );
    expect((await sender.inbox())[0]).toMatchObject({ id: sent.id, status: 'completed' });
    expect((await sender.inbox())[0]?.error).toBeUndefined();
  });

  it.each(['hold', 'refuse'] as const)('honors %s while a delivery attempt returns busy', async policy => {
    const sender = await start('sender');
    let finish: ((result: PeerDeliveryResult) => void) | undefined;
    const deliver = vi.fn(
      () =>
        new Promise<PeerDeliveryResult>(resolve => {
          finish = resolve;
        })
    );
    const receiver = await start('receiver', { deliver });
    await receiver.setPolicy('accept');
    const sent = receipt(await sender.send(receiver.identity.id, 'wait for safe admission'));
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    await receiver.setPolicy(policy);
    finish?.({ status: 'busy' });
    await vi.waitFor(async () =>
      expect((await receiver.inbox())[0]).toMatchObject({
        id: sent.id,
        status: policy === 'hold' ? 'held' : 'rejected',
      })
    );
    await new Promise(resolve => setTimeout(resolve, 550));
    expect(deliver).toHaveBeenCalledTimes(1);
    if (policy === 'hold') {
      await receiver.release(sent.id);
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
      finish?.({ status: 'completed', text: 'explicitly released' });
      await vi.waitFor(async () =>
        expect(receipt(await sender.status(receiver.identity.id, sent.id))).toMatchObject({ status: 'completed' })
      );
    }
  });

  it('keeps retired outgoing pending receipts unknown after their local deadline', async () => {
    let now = Date.now();
    const sender = await start('sender', { now: () => now });
    const receiver = await start('receiver', { now: () => now });
    const sent = receipt(await sender.send(receiver.identity.id, 'unconfirmed retired send'));
    await sender.close();
    now += 15 * 60 * 1000;
    const resumed = await start('resumed', {
      identity: { ...identity('resumed'), threadId: sender.identity.threadId },
      now: () => now,
    });
    expect((await resumed.inbox())[0]).toMatchObject({ id: sent.id, status: 'unknown' });
  });
});
