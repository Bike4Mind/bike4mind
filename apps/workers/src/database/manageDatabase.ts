// Lambda event handlers for the ManageDatabase suite of SST scripts.
// createDatabase: runs when a new stack is created; seeds and migrates up.

import { MigrationManager } from '@bike4mind/scripts';
import { AnalyticsDaily, AnalyticsUserDay, connectDB, getDB } from '@bike4mind/database';
import { ensureAtlasVectorSearchIndexes } from '@bike4mind/fab-pipeline';
import { Context } from 'aws-lambda';
import { Config } from '@bike4mind/server-utils/utils/config';
import { Logger } from '@bike4mind/observability';
import { contextToLogs } from '@bike4mind/server-utils/utils/logger';
import { Resource } from 'sst';

function migrationUri(): string {
  let dedicated: string | undefined;
  try {
    dedicated = (Resource as unknown as { MONGODB_MIGRATION_URI: { value: string } }).MONGODB_MIGRATION_URI.value;
  } catch {
    // Older/self-host deployments do not link the optional migration role.
  }
  if (dedicated && dedicated !== 'not-configured') {
    if (!/^mongodb(\+srv)?:\/\//.test(dedicated)) throw new Error('Invalid migration database URI');
    if (process.env.MIRROR_REQUIRE_DATABASE_ROLES === 'true' && dedicated === Config.MONGODB_URI) {
      throw new Error('Migration database role must differ from the legacy credential');
    }
    return dedicated;
  }
  if (process.env.MIRROR_REQUIRE_DATABASE_ROLES === 'true') {
    throw new Error('Migration database role is not configured');
  }
  return Config.MONGODB_URI;
}

// The rollup upserts rely on the unique indexes, so create them before the first write.
export const ensureAnalyticsIndexes = async () => {
  await AnalyticsUserDay.createIndexes();
  await AnalyticsDaily.createIndexes();
};

export const createDatabase = async (_event: unknown, context: Context) => {
  const logger = new Logger().withMetadata(contextToLogs(context));
  logger.log(`createDatabase: ${Config.STAGE}`);
  await connectDB(migrationUri().replace('%STAGE%', Config.STAGE));
  const manager = new MigrationManager(logger);
  await manager.seed();
  await manager.up(null);
  await ensureAtlasVectorSearchIndexes(getDB().connection, logger);
  await ensureAnalyticsIndexes();
};

// updateDatabase: runs when an existing stack is updated; migrates the schema.
export const updateDatabase = async (_event: unknown, context: Context) => {
  const logger = new Logger().withMetadata(contextToLogs(context));
  logger.log(`updateDatabase: ${Config.STAGE}`);
  await connectDB(migrationUri().replace('%STAGE%', Config.STAGE));
  await new MigrationManager(logger).up(null);
  await ensureAtlasVectorSearchIndexes(getDB().connection, logger);
  await ensureAnalyticsIndexes();
};

// deleteDatabase: runs when an existing stack is deleted; drops all collections and the database.
export const deleteDatabase = async (_event: unknown, context: Context) => {
  const logger = new Logger().withMetadata(contextToLogs(context));
  logger.log(`deleteDatabase: ${Config.STAGE}`);
  const uri = migrationUri();
  if (!uri.includes('%STAGE%')) {
    return;
  }

  logger.log(`deleteDatabase: Dropping database for stage ${Config.STAGE}}`);
  await connectDB(uri.replace('%STAGE%', Config.STAGE));
  const mongoose = getDB();
  const collections = await mongoose.connection.db!.collections();
  for (const collection of collections) {
    logger.log(`Dropping collection ${collection.collectionName}`);
    await collection.drop();
  }
  await mongoose.connection.db!.dropDatabase();
};
