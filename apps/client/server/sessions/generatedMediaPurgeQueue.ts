import { Resource } from 'sst';
import { getSourceQueueUrl } from '@bike4mind/server-utils/utils/dlqRegistry';
import { sendToQueue } from '@bike4mind/server-utils/utils/sqs';
import type { MinimalLogger } from '@server/services/publish/minimalLogger';

// Message contract read by apps/workers/src/queueHandlers/generatedMediaPurge.ts.
export type GeneratedMediaPurgeMessage = { kind: 'sessions'; sessionIds: string[] } | { kind: 'keys'; keys: string[] };

export const MAX_PURGE_SESSION_IDS = 500;
export const MAX_PURGE_KEYS = 5000;
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
}: {
  sessionIds?: string[];
  keys?: string[];
}): GeneratedMediaPurgeMessage[] {
  const messages: GeneratedMediaPurgeMessage[] = [];
  for (let i = 0; i < sessionIds.length; i += MAX_PURGE_SESSION_IDS) {
    messages.push({ kind: 'sessions', sessionIds: sessionIds.slice(i, i + MAX_PURGE_SESSION_IDS) });
  }
  let chunk: string[] = [];
  let bytes = 0;
  for (const key of keys) {
    const size = Buffer.byteLength(JSON.stringify(key)) + 1;
    if (chunk.length > 0 && (bytes + size > MAX_KEYS_MESSAGE_BYTES || chunk.length >= MAX_PURGE_KEYS)) {
      messages.push({ kind: 'keys', keys: chunk });
      chunk = [];
      bytes = 0;
    }
    chunk.push(key);
    bytes += size;
  }
  if (chunk.length > 0) messages.push({ kind: 'keys', keys: chunk });
  return messages;
}

/**
 * Hand generated media a purge did not reach to the purge worker. Never throws; returns false when any
 * message was not sent (logged with the counts it dropped).
 */
export async function enqueueGeneratedMediaPurge(
  leftovers: { sessionIds?: string[]; keys?: string[] },
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
