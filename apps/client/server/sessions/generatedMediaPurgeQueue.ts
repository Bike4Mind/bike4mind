import { Resource } from 'sst';
import { getSourceQueueUrl } from '@bike4mind/server-utils/utils/dlqRegistry';
import { sendToQueue } from '@bike4mind/server-utils/utils/sqs';
import type { MinimalLogger } from '@bike4mind/server-utils/services/publish/minimalLogger';

// Message contract read by apps/workers/src/queueHandlers/generatedMediaPurge.ts.
// `ownerIds` on a keys message are the users the worker re-checks the keys' ownership against.
export type GeneratedMediaPurgeMessage =
  { kind: 'sessions'; sessionIds: string[] } | { kind: 'keys'; keys: string[]; ownerIds: string[] };

export const MAX_PURGE_SESSION_IDS = 500;
export const MAX_PURGE_KEYS = 5000;
export const MAX_PURGE_OWNER_IDS = 100;
// Serialized body cap per keys message, under SQS's 256 KiB limit.
const MAX_KEYS_MESSAGE_BYTES = 200_000;

// The worker links its own queue; API Lambdas only carry the sourceQueueUrls Linkable. sst's Resource
// proxy throws on an unlinked key, hence the try.
const resolveQueueUrl = (): string => {
  try {
    const directUrl = (Resource as unknown as { generatedMediaPurgeQueue?: { url?: string } }).generatedMediaPurgeQueue
      ?.url;
    if (directUrl) return directUrl;
  } catch {
    // Not linked directly in this Lambda; fall through to the registry.
  }
  return getSourceQueueUrl('generatedMediaPurgeQueue');
};

export function buildGeneratedMediaPurgeMessages({
  sessionIds = [],
  keys = [],
  ownerIds = [],
}: {
  sessionIds?: string[];
  keys?: string[];
  ownerIds?: string[];
}): GeneratedMediaPurgeMessage[] {
  const messages: GeneratedMediaPurgeMessage[] = [];
  for (let i = 0; i < sessionIds.length; i += MAX_PURGE_SESSION_IDS) {
    messages.push({ kind: 'sessions', sessionIds: sessionIds.slice(i, i + MAX_PURGE_SESSION_IDS) });
  }
  // Keys without an owner to check against could never be purged, so they are not sent.
  const owners = [...new Set(ownerIds)].slice(0, MAX_PURGE_OWNER_IDS);
  if (owners.length === 0) return messages;
  let chunk: string[] = [];
  let bytes = JSON.stringify(owners).length;
  for (const key of keys) {
    const size = Buffer.byteLength(JSON.stringify(key)) + 1;
    if (chunk.length > 0 && (bytes + size > MAX_KEYS_MESSAGE_BYTES || chunk.length >= MAX_PURGE_KEYS)) {
      messages.push({ kind: 'keys', keys: chunk, ownerIds: owners });
      chunk = [];
      bytes = JSON.stringify(owners).length;
    }
    chunk.push(key);
    bytes += size;
  }
  if (chunk.length > 0) messages.push({ kind: 'keys', keys: chunk, ownerIds: owners });
  return messages;
}

/**
 * Hand generated media a purge did not reach to the purge worker. Never throws; returns false when any
 * message was not sent (logged with the counts it dropped).
 */
export async function enqueueGeneratedMediaPurge(
  leftovers: { sessionIds?: string[]; keys?: string[]; ownerIds?: string[] },
  logger: MinimalLogger
): Promise<boolean> {
  const messages = buildGeneratedMediaPurgeMessages(leftovers);
  if (messages.length === 0) return true;
  let queueUrl: string;
  try {
    queueUrl = resolveQueueUrl();
  } catch (err) {
    logger.warn(
      `[NOTEBOOK_MEDIA] Purge queue unavailable; dropped ${leftovers.keys?.length ?? 0} keys and ${leftovers.sessionIds?.length ?? 0} notebooks: ${err instanceof Error ? err.message : String(err)}`
    );
    return false;
  }
  let failed = 0;
  for (const message of messages) {
    try {
      await sendToQueue(queueUrl, message);
    } catch (err) {
      failed++;
      const count = message.kind === 'sessions' ? message.sessionIds.length : message.keys.length;
      logger.warn(
        `[NOTEBOOK_MEDIA] Could not enqueue a ${message.kind} purge of ${count}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  return failed === 0;
}
