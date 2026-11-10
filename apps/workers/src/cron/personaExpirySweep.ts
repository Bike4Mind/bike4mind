import { Context } from 'aws-lambda';
import { Logger } from '@bike4mind/observability';
import { randomUUID } from 'crypto';
import { connectDB } from '@bike4mind/database';
import { Config } from '@bike4mind/server-utils/utils/config';
import { disableExpiredPersonas } from '@server/personas/personaAccounts';
import { Resource } from 'sst';

/**
 * Daily: disables test personas past their personaExpiresAt (suspend + sign out everywhere). The
 * persona mint route runs the same sweep before it counts its caps, so this only covers stages
 * where nothing mints for a while.
 */
export async function handler(_event: never, context: Context) {
  const logger = new Logger().withMetadata({
    requestId: context.awsRequestId ?? randomUUID(),
    functionName: context.functionName,
    functionVersion: context.functionVersion,
    stage: Resource.App.stage,
  });

  try {
    await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage), logger);
    const result = await disableExpiredPersonas({ logger });
    logger.log(`[PersonaExpirySweep] Disabled ${result.disabled} expired personas`);
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (error) {
    logger.error('[PersonaExpirySweep] Failed:', error);
    throw error;
  }
}
