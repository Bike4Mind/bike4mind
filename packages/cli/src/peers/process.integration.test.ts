import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PeerIdentity, PeerReceipt, PeerResponse } from './protocol.js';

let root: string;
let workers: FakePeer[];

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'b4m-peer-process-'));
  workers = [];
});

afterEach(async () => {
  await Promise.all(workers.map(worker => worker.stop()));
  await fs.rm(root, { recursive: true, force: true });
});

class FakePeer {
  private readonly child: ChildProcess;
  private nextId = 0;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private exited = false;
  readonly identity: PeerIdentity;

  constructor(name: string, threadId: string = randomUUID()) {
    this.identity = {
      id: randomUUID(),
      generation: randomUUID(),
      threadId,
      name,
      accountId: 'fake-account',
      projectId: 'fake-project',
    };
    this.child = fork(fileURLToPath(new URL('./fixtures/peerProcess.ts', import.meta.url)), [], {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    this.child.on('message', (value: unknown) => {
      if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'number') return;
      const pending = this.pending.get(value.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(value.id);
      if ('error' in value) pending.reject(new Error(String(value.error)));
      else pending.resolve('result' in value ? value.result : undefined);
    });
    this.child.on('exit', () => {
      this.exited = true;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Fake peer exited'));
      }
      this.pending.clear();
    });
    this.child.stderr?.on('data', () => undefined);
  }

  async start(): Promise<void> {
    await this.call({ action: 'start', root, identity: this.identity });
  }

  call<T = unknown>(command: Record<string, unknown>): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Fake peer command timed out: ${String(command.action)}`));
      }, 8000);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      this.child.send({ ...command, id });
    });
  }

  async stop(): Promise<void> {
    if (this.exited) return;
    try {
      await this.call({ action: 'close' });
    } catch {
      /* A crashed fixture may already have lost IPC. */
    }
    if (this.child.connected) this.child.disconnect();
    if (this.exited) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        this.child.kill('SIGKILL');
      }, 1500);
      this.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

function receipt(response: PeerResponse): PeerReceipt {
  if (!response.ok || !response.receipt) throw new Error(JSON.stringify(response));
  return response.receipt;
}

it('discovers, approves, queues, replies, and reconciles across independent fake-agent processes without Desktop', async () => {
  const sender = new FakePeer('api');
  const receiver = new FakePeer('client');
  workers.push(sender, receiver);
  await Promise.all([sender.start(), receiver.start()]);
  expect(await sender.call({ action: 'list' })).toEqual([
    { ...receiver.identity, presence: { policy: 'hold', ready: true } },
  ]);
  const held = receipt(
    await sender.call<PeerResponse>({ action: 'send', target: receiver.identity.id, text: 'contract summary' })
  );
  expect(held.status).toBe('held');
  await receiver.call({ action: 'release', messageId: held.id });
  await vi.waitFor(async () => {
    const result = receipt(
      await sender.call<PeerResponse>({ action: 'status', target: receiver.identity.id, messageId: held.id })
    );
    expect(result).toMatchObject({ status: 'completed', result: 'fake-result:contract summary' });
  });
  const reply = receipt(await receiver.call<PeerResponse>({ action: 'reply', messageId: held.id, text: 'received' }));
  expect(reply).toMatchObject({ replyTo: held.id, hops: 1, status: 'held' });

  await receiver.call({ action: 'ready', ready: false });
  await receiver.call({ action: 'accept' });
  const queued = receipt(
    await sender.call<PeerResponse>({ action: 'send', target: receiver.identity.id, text: 'wait for idle' })
  );
  expect(queued.status).toBe('queued');
  expect(
    receipt(await sender.call<PeerResponse>({ action: 'status', target: receiver.identity.id, messageId: queued.id }))
      .status
  ).toBe('queued');
  await receiver.call({ action: 'ready', ready: true });
  await vi.waitFor(async () =>
    expect(
      receipt(await sender.call<PeerResponse>({ action: 'status', target: receiver.identity.id, messageId: queued.id }))
        .status
    ).toBe('completed')
  );

  await receiver.stop();
  const replacement = new FakePeer('client', receiver.identity.threadId);
  workers.push(replacement);
  await replacement.start();
  const peers = await sender.call<PeerIdentity[]>({ action: 'list' });
  expect(peers.map(peer => peer.id)).toEqual([replacement.identity.id]);
  expect(await replacement.call<PeerReceipt[]>({ action: 'inbox' })).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: held.id, status: 'completed', result: 'fake-result:contract summary' }),
      expect.objectContaining({ id: queued.id, status: 'completed' }),
    ])
  );
  expect(
    await sender.call<PeerResponse>({ action: 'status', target: receiver.identity.id, messageId: queued.id })
  ).toMatchObject({ ok: false });
}, 20_000);
