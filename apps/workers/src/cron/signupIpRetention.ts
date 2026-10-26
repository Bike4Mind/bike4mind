import { Context } from 'aws-lambda';
import { Logger } from '@bike4mind/observability';
import { randomUUID } from 'crypto';
import { isIP } from 'net';
import { AUTH_EVENT_RETENTION_SECONDS, connectDB, User } from '@bike4mind/database';
import { Config } from '@bike4mind/server-utils/utils/config';
import { truncateIp } from '@bike4mind/server-utils/utils/ip';
import { Resource } from 'sst';

const retentionLogger = new Logger({ metadata: { service: 'signupIpRetention' } });

// Same window as the AuthEvent TTL, so the full signup IP never outlives the login-history copy.
const SIGNUP_IP_RETENTION_MS = AUTH_EVENT_RETENTION_SECONDS * 1000;
const DEFAULT_BATCH_SIZE = 1000;

const contextToLogs = (context: Context) => ({
  requestId: context.awsRequestId ?? randomUUID(),
  functionName: context.functionName,
  functionVersion: context.functionVersion,
  stage: Resource.App.stage,
});

export async function handler(event: never, context: Context) {
  const logger = new Logger().withMetadata(contextToLogs(context));

  try {
    await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage), logger);
    const result = await runSignupIpRetention({ logger });
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (error) {
    logger.error('[SignupIpRetention] Failed:', error);
    throw error;
  }
}

/**
 * Replace `signupMeta.ip` with its truncated prefix once the signup is older than the retention
 * window. Idempotent: truncated rows are skipped, and each write is conditioned on the IP it read.
 * Exported without the DB connect so the self-host worker can call it directly.
 */
export async function runSignupIpRetention(options: { logger?: Logger; batchSize?: number; now?: Date } = {}) {
  const logger = options.logger ?? retentionLogger;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error('Invalid signup IP retention batch size');
  const cutoff = new Date((options.now ?? new Date()).getTime() - SIGNUP_IP_RETENTION_MS);

  const pending: Parameters<typeof User.bulkWrite>[0] = [];
  let truncatedCount = 0;
  let unshortenableCount = 0;
  let batches = 0;

  const flush = async () => {
    if (pending.length === 0) return;
    const result = await User.bulkWrite(pending.splice(0), { ordered: false });
    truncatedCount += result.modifiedCount;
    batches++;
    logger.log(`[SignupIpRetention] Batch ${batches}: truncated ${result.modifiedCount} signup IPs`);
  };

  // A single cursor pass rather than re-querying until empty: an IP truncateIp cannot shorten
  // would otherwise match every iteration and never let the loop end. Already-truncated rows are
  // filtered in process, not by a regex in the query, so the filter stays portable to DocumentDB.
  // `$exists` lets DocumentDB use the sparse capturedAt index, which it ignores without one.
  const cursor = User.find(
    {
      'signupMeta.capturedAt': { $exists: true, $lt: cutoff },
      'signupMeta.ip': { $type: 'string' },
    },
    { 'signupMeta.ip': 1 }
  )
    .lean()
    .cursor({ batchSize });

  for await (const user of cursor) {
    const ip = user.signupMeta?.ip;
    if (!ip) continue;
    const truncatedIp = truncateIp(ip);
    if (truncatedIp === ip) {
      if (isIP(ip) === 0) unshortenableCount++;
      continue;
    }
    pending.push({
      updateOne: {
        filter: { _id: user._id, 'signupMeta.ip': ip },
        update: { $set: { 'signupMeta.ip': truncatedIp } },
        // A retention rewrite is not a user change, so it must not bump updatedAt.
        timestamps: false,
      },
    });
    if (pending.length >= batchSize) await flush();
  }
  await flush();

  if (unshortenableCount > 0) {
    logger.warn(`[SignupIpRetention] ${unshortenableCount} signup IPs are not an address truncateIp can shorten`);
  }
  logger.log(
    `[SignupIpRetention] Truncated ${truncatedCount} signup IPs in ${batches} batches (cutoff: ${cutoff.toISOString()})`
  );
  return { truncatedCount, batches, cutoff: cutoff.toISOString() };
}
