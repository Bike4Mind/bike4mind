import { createHash, randomUUID } from 'node:crypto';
import { isPeerIdentity, isPeerRequest } from './protocol.js';
import type { PeerIdentity, PeerMessage, PeerReceipt, PeerRequest, PeerResponse } from './protocol.js';
import { callPeer, discoverPeers, startPeerTransport } from './transport.js';
import { PeerStorage } from './storage.js';

export type PeerInboundPolicy = 'hold' | 'accept' | 'refuse';
export interface PeerProvenance {
  messageId: string;
  senderId: string;
  senderName: string;
  replyTo?: string;
}
export interface PeerDeliveryResult {
  status: 'completed' | 'cancelled' | 'failed' | 'stopped' | 'busy';
  text?: string;
  error?: string;
}
export interface PeerServiceOptions {
  root: string;
  identity: PeerIdentity;
  canDeliver: () => boolean;
  deliver: (text: string, provenance: PeerProvenance) => Promise<PeerDeliveryResult>;
  notify?: (message: string) => void;
  now?: () => number;
}
interface StoredReceipt {
  receipt: PeerReceipt;
  peer: PeerIdentity;
  fingerprint: string;
  updatedAt: number;
  approved: boolean;
  removed?: boolean;
}
interface InboxSnapshot {
  version: 1;
  identity: PeerIdentity;
  incoming: StoredReceipt[];
  outgoing: StoredReceipt[];
}

const MESSAGE_TTL_MS = 15 * 60 * 1000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RECEIPTS = 1024;
const MAX_PENDING = 20;
const MAX_TEXT_BYTES = 8 * 1024;
const MAX_RESULT_BYTES = 16 * 1024;
const pendingStatuses = new Set(['queued', 'held']);

export class PeerService {
  readonly identity: PeerIdentity;
  private readonly storage: PeerStorage;
  private readonly incoming = new Map<string, StoredReceipt>();
  private readonly outgoing = new Map<string, StoredReceipt>();
  private readonly historical = new Map<
    string,
    { stored: StoredReceipt; snapshot: InboxSnapshot; storage: PeerStorage }
  >();
  private policy: PeerInboundPolicy = 'hold';
  private transport: Awaited<ReturnType<typeof startPeerTransport>> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private serial: Promise<unknown> = Promise.resolve();
  private delivery: Promise<void> | undefined;
  private deliveryParent: StoredReceipt | undefined;
  private closed = true;
  private storageFault = false;
  private sends = 0;

  constructor(private readonly options: PeerServiceOptions) {
    if (!isPeerIdentity(options.identity)) throw new Error('Invalid peer identity');
    this.identity = { ...options.identity };
    this.storage = new PeerStorage(options.root, `${this.identity.id}-${this.identity.generation}`);
  }

  async start(): Promise<void> {
    if (!this.closed) return;
    if (this.delivery) throw new Error('A prior peer delivery is still completing');
    this.storageFault = false;
    await this.storage.init();
    const saved = await this.storage.load();
    this.incoming.clear();
    this.outgoing.clear();
    this.policy = 'hold';
    if (saved !== undefined) this.restore(saved);
    await this.loadHistory();
    await this.persist();
    this.closed = false;
    try {
      this.transport = await startPeerTransport({
        root: this.options.root,
        identity: this.identity,
        handle: (sender, request) => this.handle(sender, request),
      });
      this.timer = setInterval(() => this.drain(), 500);
      this.timer.unref();
    } catch (error) {
      this.closed = true;
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    await this.transport?.close();
    this.transport = undefined;
    await this.exclusive(async () => {
      for (const stored of this.incoming.values()) {
        if (stored.receipt.status === 'delivered') {
          stored.receipt.status = 'unknown';
          stored.receipt.error = 'Receiver closed before result confirmation';
        } else if (pendingStatuses.has(stored.receipt.status)) {
          stored.receipt.status = 'held';
          stored.approved = false;
        }
      }
      await this.persist();
    });
  }

  getPolicy(): PeerInboundPolicy {
    return this.policy;
  }

  resetSendBudget(): void {
    this.sends = 0;
  }

  async list(): Promise<Array<PeerIdentity & { presence?: { policy: PeerInboundPolicy; ready: boolean } }>> {
    this.assertOpen();
    const peers = await discoverPeers(this.options.root, this.identity);
    return Promise.all(
      peers
        .filter(peer => peer.id !== this.identity.id)
        .slice(0, 50)
        .map(async peer => {
          const response = await callPeer(this.options.root, this.identity, peer.id, { type: 'presence' });
          return { ...peer, presence: response.ok ? response.presence : undefined };
        })
    );
  }

  async prepareSendTarget(target: string, reply = false): Promise<PeerIdentity> {
    this.assertOpen();
    const parent = reply ? this.incoming.get(target) : undefined;
    if (reply && !parent) throw new Error('Received message not found');
    const peer = await this.resolve(parent ? parent.peer.id : target);
    this.assertOpen();
    if (!peer || (parent && !samePeer(parent.peer, peer))) throw new Error('Peer is unavailable or changed');
    return Object.freeze({ ...peer });
  }

  async send(target: string, text: string, replyTo?: string, expectedPeer?: PeerIdentity): Promise<PeerResponse> {
    this.assertOpen();
    if (!text.trim() || Buffer.byteLength(text) > MAX_TEXT_BYTES)
      return failure('Message must contain 1 to 8192 UTF-8 bytes');
    if (this.sends >= 2) return failure('Peer send limit reached for this turn');
    const peer = await this.resolve(target);
    this.assertOpen();
    if (!peer) return failure('Peer not found or name is ambiguous');
    if (expectedPeer && !samePeer(peer, expectedPeer))
      return failure('Approved recipient changed; approve a new message');
    if (this.deliveryParent && !samePeer(this.deliveryParent.peer, peer))
      return failure('Peer-origin turns may only reply to their sender');
    if (this.deliveryParent && replyTo && replyTo !== this.deliveryParent.receipt.id)
      return failure('Peer-origin replies must retain their active message chain');
    replyTo ??= this.deliveryParent?.receipt.id;
    const parent = replyTo ? this.incoming.get(replyTo) : undefined;
    if (replyTo && (!parent || !samePeer(parent.peer, peer)))
      return failure('Reply must target the authenticated sender of a received message');
    const hops = parent ? parent.receipt.hops + 1 : 0;
    if (hops > 5) return failure('Peer reply hop limit reached');
    const now = this.now();
    const message: PeerMessage = {
      id: randomUUID(),
      text,
      replyTo,
      hops,
      createdAt: now,
      expiresAt: now + MESSAGE_TTL_MS,
    };
    const stored: StoredReceipt = {
      receipt: { ...message, senderId: this.identity.id, recipientId: peer.id, status: 'unknown' },
      peer,
      fingerprint: fingerprint(this.identity, message),
      updatedAt: now,
      approved: true,
    };
    const admitted = await this.exclusive(async () => {
      this.prune();
      if (this.outgoing.size >= MAX_RECEIPTS || this.sends >= 2) return false;
      this.sends++;
      this.outgoing.set(message.id, stored);
      await this.persist();
      return true;
    });
    if (!admitted) return failure('Peer send or receipt storage limit reached');
    let response: PeerResponse;
    try {
      response = await callPeer(
        this.options.root,
        this.identity,
        peer.id,
        { type: 'send', message },
        expectedPeer ?? peer
      );
    } catch (error) {
      response = { ok: false, unknown: true, error: error instanceof Error ? error.message : String(error) };
    }
    await this.exclusive(async () => {
      if (response.ok && response.receipt && receiptMatches(response.receipt, stored.receipt))
        stored.receipt = { ...stored.receipt, ...response.receipt };
      else {
        stored.receipt.status = !response.ok && !response.unknown ? 'rejected' : 'unknown';
        stored.receipt.error = response.ok ? 'Invalid peer receipt' : response.error;
      }
      stored.updatedAt = this.now();
      await this.persist();
    });
    return response.ok ? { ok: true, receipt: { ...stored.receipt } } : response;
  }

  async reply(messageId: string, text: string, expectedPeer?: PeerIdentity): Promise<PeerResponse> {
    const parent = this.incoming.get(messageId);
    if (!parent) return failure('Received message not found');
    return this.send(parent.peer.id, text, messageId, expectedPeer);
  }

  async inbox(): Promise<PeerReceipt[]> {
    return this.exclusive(async () => {
      this.prune();
      await this.persist();
      return [
        ...this.incoming.values(),
        ...this.outgoing.values(),
        ...[...this.historical.values()].map(item => item.stored),
      ]
        .filter(stored => !stored.removed)
        .map(stored => ({ ...stored.receipt }));
    });
  }

  async status(target: string, messageId: string): Promise<PeerResponse> {
    return this.remoteReceipt(target, messageId, 'status');
  }

  async cancel(target: string, messageId: string): Promise<PeerResponse> {
    return this.remoteReceipt(target, messageId, 'cancel');
  }

  async setPolicy(policy: PeerInboundPolicy): Promise<void> {
    this.assertOpen();
    if (!['hold', 'accept', 'refuse'].includes(policy)) throw new Error('Invalid peer inbound policy');
    await this.exclusive(async () => {
      this.policy = policy;
      for (const stored of this.incoming.values()) {
        // Delivery can still return busy before the turn is admitted.
        if (stored.receipt.status === 'delivered') {
          stored.approved = policy === 'accept';
          continue;
        }
        if (!pendingStatuses.has(stored.receipt.status)) continue;
        if (policy === 'refuse') {
          stored.receipt.status = 'rejected';
          stored.receipt.error = 'Recipient refuses peer messages';
        } else if (policy === 'accept') {
          stored.receipt.status = 'queued';
          stored.approved = true;
        } else {
          stored.approved = false;
          stored.receipt.status = 'held';
        }
      }
      await this.persist();
    });
    this.drain();
  }

  async release(messageId: string): Promise<void> {
    this.assertOpen();
    await this.exclusive(async () => {
      const stored = this.incoming.get(messageId);
      if (!stored || !pendingStatuses.has(stored.receipt.status)) throw new Error('Pending received message not found');
      if (this.policy === 'refuse') throw new Error('Change inbound policy before releasing messages');
      if (stored.receipt.expiresAt <= this.now()) throw new Error('Message has expired');
      const peers = await discoverPeers(this.options.root, this.identity);
      if (!peers.some(peer => samePeer(peer, stored.peer)))
        throw new Error('Sender is disconnected; it must reconnect before this message can be released');
      stored.approved = true;
      stored.receipt.status = 'queued';
      await this.persist();
    });
    this.drain();
  }

  async remove(messageId: string): Promise<void> {
    this.assertOpen();
    const outgoing = this.outgoing.get(messageId);
    if (outgoing?.receipt.status === 'unknown')
      throw new Error('Reconcile unknown delivery before deleting a sent message');
    if (outgoing && pendingStatuses.has(outgoing.receipt.status)) {
      const response = await this.cancel(outgoing.peer.id, messageId);
      if (
        !response.ok ||
        !response.receipt ||
        !['cancelled', 'expired', 'rejected'].includes(response.receipt.status)
      ) {
        throw new Error('Confirm remote cancellation before deleting pending sent input');
      }
    }
    await this.exclusive(async () => {
      const stored = this.incoming.get(messageId) ?? this.outgoing.get(messageId);
      if (!stored) {
        const historical = this.historical.get(messageId);
        if (!historical) throw new Error('Message not found');
        const record = [...historical.snapshot.incoming, ...historical.snapshot.outgoing].find(
          item => item.receipt.id === messageId
        );
        if (!record) throw new Error('Historical message not found');
        delete record.receipt.text;
        delete record.receipt.result;
        delete historical.stored.receipt.text;
        delete historical.stored.receipt.result;
        record.removed = true;
        if (historical.stored.receipt.status !== 'unknown') historical.stored.removed = true;
        else record.removed = false;
        await historical.storage.save(historical.snapshot);
        return;
      }
      if (stored.receipt.status === 'delivered') throw new Error('Cannot delete an active message');
      if (pendingStatuses.has(stored.receipt.status)) stored.receipt.status = 'cancelled';
      delete stored.receipt.text;
      delete stored.receipt.result;
      stored.removed = true;
      await this.persist();
    });
  }

  private async remoteReceipt(target: string, messageId: string, type: 'status' | 'cancel'): Promise<PeerResponse> {
    this.assertOpen();
    const stored = this.outgoing.get(messageId);
    if (!stored || stored.peer.id !== target) return failure('Sent message not found for that peer');
    const response = await callPeer(this.options.root, this.identity, target, { type, messageId }, stored.peer);
    await this.exclusive(async () => {
      if (response.ok && response.receipt && receiptMatches(response.receipt, stored.receipt)) {
        stored.receipt = { ...response.receipt, text: stored.receipt.text };
        stored.updatedAt = this.now();
        await this.persist();
      }
    });
    return response;
  }

  private async handle(sender: PeerIdentity, request: PeerRequest): Promise<PeerResponse> {
    return this.exclusive(async () => {
      if (this.closed || this.storageFault) return failure('Peer receiver is unavailable');
      if (sender.accountId !== this.identity.accountId || sender.projectId !== this.identity.projectId)
        return failure('Peer scope is not authorized');
      if (request.type === 'presence')
        return { ok: true, presence: { policy: this.policy, ready: !this.delivery && this.options.canDeliver() } };
      this.prune();
      if (request.type !== 'send') {
        const stored = this.incoming.get(request.messageId);
        if (!stored || !samePeer(stored.peer, sender)) return failure('Message not found');
        if (request.type === 'cancel') {
          if (!pendingStatuses.has(stored.receipt.status))
            return failure('Message has already been delivered or finalized');
          stored.receipt.status = 'cancelled';
          stored.updatedAt = this.now();
        }
        await this.persist();
        return { ok: true, receipt: remoteReceipt(stored.receipt) };
      }
      const message = request.message;
      if (!isPeerRequest(request) || Buffer.byteLength(message.text) > MAX_TEXT_BYTES)
        return failure('Invalid or oversized peer message');
      const existing = this.incoming.get(message.id);
      if (existing) {
        if (!samePeer(existing.peer, sender) || existing.fingerprint !== fingerprint(sender, message))
          return failure('Message ID conflicts with an existing request');
        return { ok: true, receipt: remoteReceipt(existing.receipt) };
      }
      if (
        message.expiresAt <= this.now() ||
        message.expiresAt - message.createdAt > MESSAGE_TTL_MS ||
        message.createdAt > this.now() + 30_000
      )
        return failure('Invalid or expired peer message deadline');
      if (message.replyTo) {
        const parent = this.outgoing.get(message.replyTo);
        if (!parent || !samePeer(parent.peer, sender) || message.hops !== parent.receipt.hops + 1)
          return failure('Reply does not match a message sent to that peer');
      } else if (message.hops !== 0) return failure('Initial messages must start at hop zero');
      if (this.policy === 'refuse') return failure('Recipient refuses peer messages');
      const pending = [...this.incoming.values()].filter(stored => pendingStatuses.has(stored.receipt.status)).length;
      if (pending >= MAX_PENDING || this.incoming.size >= MAX_RECEIPTS) return failure('Peer inbox is full');
      const recent = [...this.incoming.values()].filter(
        stored => samePeer(stored.peer, sender) && stored.updatedAt > this.now() - 60_000
      ).length;
      if (recent >= 10) return failure('Peer sender rate limit reached');
      const receipt: PeerReceipt = {
        ...message,
        senderId: sender.id,
        recipientId: this.identity.id,
        status: this.policy === 'accept' ? 'queued' : 'held',
      };
      this.incoming.set(message.id, {
        receipt,
        peer: { ...sender },
        fingerprint: fingerprint(sender, message),
        updatedAt: this.now(),
        approved: this.policy === 'accept',
      });
      await this.persist();
      this.options.notify?.(`Peer message from ${sender.name}: ${receipt.status} (${receipt.id})`);
      this.drain();
      return { ok: true, receipt: remoteReceipt(receipt) };
    });
  }

  private drain(): void {
    if (this.closed || this.storageFault || this.delivery) return;
    this.delivery = this.deliverNext()
      .catch(error => this.options.notify?.(`Peer delivery failed: ${String(error)}`))
      .finally(() => {
        this.delivery = undefined;
      });
  }

  private async deliverNext(): Promise<void> {
    const stored = await this.exclusive(async () => {
      if (this.prune()) await this.persist();
      if (this.closed || this.storageFault || this.policy === 'refuse' || !this.options.canDeliver()) return undefined;
      const next = [...this.incoming.values()].find(item => item.receipt.status === 'queued' && item.approved);
      if (!next) return undefined;
      const live = await discoverPeers(this.options.root, this.identity);
      if (!live.some(peer => samePeer(peer, next.peer))) {
        next.receipt.status = 'held';
        next.approved = false;
        next.receipt.error = 'Sender is no longer live; explicit release is required';
        await this.persist();
        return undefined;
      }
      next.receipt.status = 'delivered';
      next.updatedAt = this.now();
      await this.persist();
      return next;
    });
    if (!stored) return;
    let result: PeerDeliveryResult;
    try {
      this.deliveryParent = stored;
      result = await this.options.deliver(stored.receipt.text ?? '', {
        messageId: stored.receipt.id,
        senderId: stored.peer.id,
        senderName: stored.peer.name,
        replyTo: stored.receipt.replyTo,
      });
    } catch (error) {
      result = { status: 'failed', error: error instanceof Error ? error.message : String(error) };
    } finally {
      this.deliveryParent = undefined;
    }
    await this.exclusive(async () => {
      if (this.closed) return;
      stored.receipt.status =
        result.status === 'busy'
          ? this.policy === 'refuse'
            ? 'rejected'
            : stored.approved
              ? 'queued'
              : 'held'
          : result.status;
      stored.receipt.result = result.text ? truncateUtf8(result.text, MAX_RESULT_BYTES) : undefined;
      stored.receipt.error = result.error ? truncateUtf8(result.error, 1024) : undefined;
      stored.updatedAt = this.now();
      await this.persist();
      if (result.status !== 'busy') this.options.notify?.(`Peer message ${stored.receipt.id}: ${result.status}`);
    });
  }

  private async resolve(target: string): Promise<PeerIdentity | undefined> {
    const peers = await this.list();
    const exact = peers.find(peer => peer.id === target);
    if (exact) return exact;
    const matches = peers.filter(peer => peer.name === target || peer.id.startsWith(target));
    return matches.length === 1 ? matches[0] : undefined;
  }

  private restore(value: unknown): void {
    if (
      !value ||
      typeof value !== 'object' ||
      !('version' in value) ||
      value.version !== 1 ||
      !('identity' in value) ||
      !isPeerIdentity(value.identity) ||
      !samePeer(value.identity, this.identity) ||
      !('incoming' in value) ||
      !('outgoing' in value) ||
      !Array.isArray(value.incoming) ||
      !Array.isArray(value.outgoing)
    )
      throw new Error('Invalid persisted peer inbox');
    for (const [records, destination] of [
      [value.incoming, this.incoming],
      [value.outgoing, this.outgoing],
    ] as const) {
      if (records.length > MAX_RECEIPTS) throw new Error('Peer receipt limit exceeded');
      for (const record of records) {
        if (!isStoredReceipt(record)) throw new Error('Invalid persisted peer receipt');
        if (destination.has(record.receipt.id)) throw new Error('Duplicate persisted peer receipt');
        if (record.receipt.status === 'delivered') {
          record.receipt.status = 'unknown';
          record.receipt.error = 'Receiver restarted before result confirmation';
        } else if (pendingStatuses.has(record.receipt.status)) {
          record.receipt.status = 'held';
          record.approved = false;
          record.receipt.error = 'Recovered message requires explicit release';
        }
        destination.set(record.receipt.id, record);
      }
    }
    this.prune();
  }

  private async loadHistory(): Promise<void> {
    this.historical.clear();
    const activeIds = new Set((await discoverPeers(this.options.root, this.identity)).map(peer => peer.id));
    for (const entry of await this.storage.history(this.now())) {
      const value = entry.value;
      if (
        !value ||
        typeof value !== 'object' ||
        !('version' in value) ||
        value.version !== 1 ||
        !('identity' in value) ||
        !isPeerIdentity(value.identity) ||
        value.identity.accountId !== this.identity.accountId ||
        value.identity.projectId !== this.identity.projectId ||
        value.identity.threadId !== this.identity.threadId ||
        !('incoming' in value) ||
        !('outgoing' in value) ||
        !Array.isArray(value.incoming) ||
        !Array.isArray(value.outgoing)
      )
        continue;
      const snapshot = value as InboxSnapshot;
      if (activeIds.has(snapshot.identity.id)) continue;
      for (const record of [...snapshot.incoming, ...snapshot.outgoing].slice(-MAX_RECEIPTS)) {
        if (
          !isStoredReceipt(record) ||
          record.updatedAt + RETENTION_MS <= this.now() ||
          this.historical.size >= MAX_RECEIPTS
        )
          continue;
        const stored: StoredReceipt = { ...record, receipt: { ...record.receipt } };
        if (pendingStatuses.has(stored.receipt.status) || stored.receipt.status === 'delivered') {
          const received = snapshot.incoming.includes(record);
          stored.receipt.status =
            received && pendingStatuses.has(stored.receipt.status) && stored.receipt.expiresAt <= this.now()
              ? 'expired'
              : 'unknown';
          stored.receipt.error = 'Historical process incarnation; reconcile manually without replay';
        }
        this.historical.set(stored.receipt.id, { stored, snapshot, storage: entry.storage });
      }
    }
  }

  private prune(): boolean {
    const now = this.now();
    let changed = false;
    for (const records of [this.incoming, this.outgoing]) {
      for (const [id, stored] of records) {
        if (pendingStatuses.has(stored.receipt.status) && stored.receipt.expiresAt <= now) {
          stored.receipt.status = records === this.incoming ? 'expired' : 'unknown';
          if (records === this.outgoing) {
            stored.receipt.error =
              'Remote execution is unconfirmed after the message deadline; query the recipient before retrying';
          }
          stored.updatedAt = now;
          changed = true;
        }
        if (stored.receipt.status === 'unknown' && stored.updatedAt + RETENTION_MS <= now) {
          if (stored.receipt.text !== undefined || stored.receipt.result !== undefined) {
            delete stored.receipt.text;
            delete stored.receipt.result;
            changed = true;
          }
          continue;
        }
        if (
          !pendingStatuses.has(stored.receipt.status) &&
          stored.receipt.status !== 'delivered' &&
          stored.updatedAt + RETENTION_MS <= now
        ) {
          records.delete(id);
          changed = true;
        }
      }
    }
    return changed;
  }

  private async persist(): Promise<void> {
    const snapshot: InboxSnapshot = {
      version: 1,
      identity: this.identity,
      incoming: [...this.incoming.values()],
      outgoing: [...this.outgoing.values()],
    };
    try {
      await this.storage.save(snapshot);
    } catch (error) {
      this.storageFault = true;
      throw error;
    }
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.then(operation, operation);
    this.serial = result.catch(() => undefined);
    return result;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private assertOpen(): void {
    if (this.closed || this.storageFault)
      throw new Error('Peer messaging is not enabled or its durable storage is unavailable');
  }
}

function samePeer(left: PeerIdentity, right: PeerIdentity): boolean {
  return (
    left.id === right.id &&
    left.generation === right.generation &&
    left.threadId === right.threadId &&
    left.accountId === right.accountId &&
    left.projectId === right.projectId
  );
}

function fingerprint(sender: PeerIdentity, message: PeerMessage): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        sender.id,
        sender.generation,
        sender.threadId,
        message.id,
        message.text,
        message.replyTo ?? null,
        message.hops,
        message.createdAt,
        message.expiresAt,
      ])
    )
    .digest('hex');
}

function receiptMatches(actual: PeerReceipt, expected: PeerReceipt): boolean {
  return (
    actual.id === expected.id && actual.senderId === expected.senderId && actual.recipientId === expected.recipientId
  );
}

function failure(error: string): PeerResponse {
  return { ok: false, error };
}

function remoteReceipt(receipt: PeerReceipt): PeerReceipt {
  const result = { ...receipt };
  delete result.text;
  return result;
}

function truncateUtf8(text: string, limit: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= limit) return text;
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, limit - 3)).replace(/\uFFFD$/, '') + '...';
}

function isStoredReceipt(value: unknown): value is StoredReceipt {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (
    !isPeerIdentity(record.peer) ||
    typeof record.fingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(record.fingerprint) ||
    typeof record.updatedAt !== 'number' ||
    !Number.isFinite(record.updatedAt) ||
    typeof record.approved !== 'boolean' ||
    !record.receipt ||
    typeof record.receipt !== 'object'
  )
    return false;
  const receipt = record.receipt as Record<string, unknown>;
  return (
    typeof receipt.id === 'string' &&
    /^[a-zA-Z0-9_-]{1,128}$/.test(receipt.id) &&
    typeof receipt.senderId === 'string' &&
    typeof receipt.recipientId === 'string' &&
    typeof receipt.status === 'string' &&
    [
      'queued',
      'held',
      'delivered',
      'completed',
      'rejected',
      'expired',
      'cancelled',
      'unknown',
      'failed',
      'stopped',
    ].includes(receipt.status) &&
    typeof receipt.createdAt === 'number' &&
    Number.isFinite(receipt.createdAt) &&
    typeof receipt.expiresAt === 'number' &&
    Number.isFinite(receipt.expiresAt) &&
    typeof receipt.hops === 'number' &&
    Number.isInteger(receipt.hops) &&
    receipt.hops >= 0 &&
    receipt.hops <= 5 &&
    (receipt.text === undefined ||
      (typeof receipt.text === 'string' && Buffer.byteLength(receipt.text) <= MAX_TEXT_BYTES)) &&
    (receipt.result === undefined ||
      (typeof receipt.result === 'string' && Buffer.byteLength(receipt.result) <= MAX_RESULT_BYTES))
  );
}
