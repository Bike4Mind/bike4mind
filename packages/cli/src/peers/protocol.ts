export interface PeerIdentity {
  id: string;
  generation: string;
  threadId: string;
  name: string;
  projectId: string;
  accountId: string;
}

export interface PeerManifest extends PeerIdentity {
  version: 1;
  endpoint: string;
  token: string;
  updatedAt: number;
  processId?: number;
}

export interface PeerMessage {
  id: string;
  text: string;
  replyTo?: string;
  hops: number;
  createdAt: number;
  expiresAt: number;
}

export type PeerReceiptStatus =
  | 'queued'
  | 'held'
  | 'delivered'
  | 'completed'
  | 'rejected'
  | 'expired'
  | 'cancelled'
  | 'unknown'
  | 'failed'
  | 'stopped';

export interface PeerReceipt {
  id: string;
  senderId: string;
  recipientId: string;
  status: PeerReceiptStatus;
  createdAt: number;
  expiresAt: number;
  text?: string;
  replyTo?: string;
  hops: number;
  result?: string;
  error?: string;
}

export type PeerRequest =
  | { type: 'presence' }
  | { type: 'send'; message: PeerMessage }
  | { type: 'status'; messageId: string }
  | { type: 'cancel'; messageId: string };

export type PeerResponse =
  | { ok: true; receipt?: PeerReceipt; presence?: { policy: 'hold' | 'accept' | 'refuse'; ready: boolean } }
  | { ok: false; error: string; unknown?: boolean };

export const PEER_PROTOCOL_VERSION = 1;
export const PEER_FRAME_LIMIT = 128 * 1024;
export const PEER_LEASE_MS = 45_000;

export function isPeerIdentity(value: unknown): value is PeerIdentity {
  if (!value || typeof value !== 'object') return false;
  const identity = value as Record<string, unknown>;
  return (
    ['id', 'generation', 'threadId'].every(
      key => typeof identity[key] === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(identity[key] as string)
    ) &&
    typeof identity.name === 'string' &&
    identity.name.length <= 200 &&
    ['projectId', 'accountId'].every(
      key =>
        typeof identity[key] === 'string' &&
        (identity[key] as string).length > 0 &&
        (identity[key] as string).length <= 4096
    )
  );
}

export function isPeerRequest(value: unknown): value is PeerRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as Record<string, unknown>;
  if (request.type === 'presence') return true;
  if (request.type === 'status' || request.type === 'cancel')
    return typeof request.messageId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(request.messageId);
  if (request.type !== 'send' || !request.message || typeof request.message !== 'object') return false;
  const message = request.message as Record<string, unknown>;
  return (
    typeof message.id === 'string' &&
    /^[a-zA-Z0-9_-]{1,128}$/.test(message.id) &&
    typeof message.text === 'string' &&
    message.text.trim().length > 0 &&
    Buffer.byteLength(message.text) <= 8 * 1024 &&
    (message.replyTo === undefined ||
      (typeof message.replyTo === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(message.replyTo))) &&
    typeof message.hops === 'number' &&
    Number.isInteger(message.hops) &&
    message.hops >= 0 &&
    message.hops <= 5 &&
    typeof message.createdAt === 'number' &&
    Number.isFinite(message.createdAt) &&
    message.createdAt >= 0 &&
    typeof message.expiresAt === 'number' &&
    Number.isFinite(message.expiresAt) &&
    message.expiresAt > message.createdAt
  );
}
