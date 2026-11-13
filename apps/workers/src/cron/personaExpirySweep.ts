import { Context } from 'aws-lambda';
import { Logger } from '@bike4mind/observability';
import { randomUUID } from 'crypto';
import { connectDB } from '@bike4mind/database';
import { Config } from '@bike4mind/server-utils/utils/config';
import { disableExpiredPersonas, readPersonaMintEnabled } from '@server/personas/personaAccounts';
import { Resource } from 'sst';

/**
 * Hourly: disables test personas past their personaExpiresAt (suspend + sign out everywhere), or
 * every live persona once PersonaMintEnabled is off. A throw is what personaExpirySweepLambdaErrors
 * in infra/alarms.ts watches.
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
    const all = !(await readPersonaMintEnabled());
    const result = await disableExpiredPersonas({ all, logger });
    logger.log(`[PersonaExpirySweep] Disabled ${result.disabled} ${all ? 'live (minting off)' : 'expired'} personas`);
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (error) {
    logger.error('[PersonaExpirySweep] Failed:', error);
    throw error;
  }
}
