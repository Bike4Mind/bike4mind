import { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { Logger } from '@bike4mind/observability';
import { MigrationManager } from '@bike4mind/scripts/migrate/migrationManager';

interface SeedInput {
  stage: string;
  timestamp: number;
  action: string;
  isPreview?: boolean;
}

function isAPIGatewayEvent(event: APIGatewayProxyEvent | SeedInput): event is APIGatewayProxyEvent {
  return 'httpMethod' in event;
}

export const handler = async (
  event: APIGatewayProxyEvent | SeedInput,
  _context: Context
): Promise<APIGatewayProxyResult | void> => {
  const logger = new Logger();

  try {
    logger.log('Starting database seeding...');
    logger.log(`Stage: ${'stage' in event ? event.stage : 'unknown'}`);

    // Only allow seeding on preview environments using IS_PREVIEW environment variable
    const isPreview = 'isPreview' in event ? event.isPreview : process.env.IS_PREVIEW === 'true';

    // Set IS_PREVIEW env var so seeders can check it (e.g., SystemSecretsSeeder skips validation in preview)
    if (isPreview) {
      process.env.IS_PREVIEW = 'true';
    }

    if (!isPreview) {
      const message = `Seeding is only allowed on preview environments. IS_PREVIEW: ${process.env.IS_PREVIEW}`;
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
    await migrationManager.seed();

    logger.log('Database seeding completed successfully');

    if (isAPIGatewayEvent(event)) {
      return {
        statusCode: 200,
        body: JSON.stringify({ message: 'Database seeding completed successfully' }),
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    logger.error('Database seeding failed:', error);

    if (isAPIGatewayEvent(event)) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: errorMessage }),
      };
    }

    throw error;
  }
};
