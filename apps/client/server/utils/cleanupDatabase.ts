import { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { Logger } from '@bike4mind/observability';
import { MigrationManager } from '@bike4mind/scripts/migrate/migrationManager';

interface CleanupInput {
  stage: string;
  timestamp: number;
  action: string;
  isPreview?: boolean;
}

function isAPIGatewayEvent(event: APIGatewayProxyEvent | CleanupInput): event is APIGatewayProxyEvent {
  return 'httpMethod' in event;
}

export const handler = async (
  event: APIGatewayProxyEvent | CleanupInput,
  _context: Context
): Promise<APIGatewayProxyResult | void> => {
  const logger = new Logger();

  try {
    logger.log('Starting database cleanup...');
    logger.log(`Stage: ${'stage' in event ? event.stage : 'unknown'}`);

    const isPreview = 'isPreview' in event ? event.isPreview : process.env.IS_PREVIEW === 'true';
    const stage = 'stage' in event ? event.stage : process.env.SEED_STAGE_NAME;

    // Safety check: only allow cleanup on preview environments (PR stages)
    if (!isPreview || !stage?.startsWith('pr')) {
      const message = `Cleanup is only allowed on preview environments. IS_PREVIEW: ${process.env.IS_PREVIEW}, Stage: ${stage}`;
      logger.log(message);

      if (isAPIGatewayEvent(event)) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: message }),
        };
      }
      return;
    }

    const migrationManager = new MigrationManager(logger);
    await migrationManager.cleanup();

    logger.log('Database cleanup completed successfully');

    if (isAPIGatewayEvent(event)) {
      return {
        statusCode: 200,
        body: JSON.stringify({ message: 'Database cleanup completed successfully' }),
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    logger.error('Database cleanup failed:', error);

    if (isAPIGatewayEvent(event)) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: errorMessage }),
      };
    }

    throw error;
  }
};
