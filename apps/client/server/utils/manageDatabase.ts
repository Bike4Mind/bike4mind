// Lambda event handlers for the ManageDatabase suite of SST scripts.
// createDatabase: runs when a new stack is created; seeds and migrates up.

import { MigrationManager } from '@bike4mind/scripts';
import { connectDB, getDB } from '@bike4mind/database';
import { Context } from 'aws-lambda';
import { Config } from './config';
import { Logger } from '@bike4mind/observability';
import { contextToLogs } from './logger';

export const createDatabase = async (_event: unknown, context: Context) => {
  const logger = new Logger().withMetadata(contextToLogs(context));
  logger.log(`createDatabase: ${Config.STAGE}`);
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Config.STAGE));
  const manager = new MigrationManager(logger);
  await manager.seed();
  await manager.up(null);
};

// updateDatabase: runs when an existing stack is updated; migrates the schema.
export const updateDatabase = async (_event: unknown, context: Context) => {
  const logger = new Logger().withMetadata(contextToLogs(context));
  logger.log(`updateDatabase: ${Config.STAGE}`);
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Config.STAGE));
  await new MigrationManager(logger).up(null);
};

// deleteDatabase: runs when an existing stack is deleted; drops all collections and the database.
export const deleteDatabase = async (_event: unknown, context: Context) => {
  const logger = new Logger().withMetadata(contextToLogs(context));
  logger.log(`deleteDatabase: ${Config.STAGE}`);
  if (!Config.MONGODB_URI.includes('%STAGE%')) {
    return;
  }

  logger.log(`deleteDatabase: Dropping database for stage ${Config.STAGE}}`);
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Config.STAGE));
  const mongoose = getDB();
  const collections = await mongoose.connection.db!.collections();
  for (const collection of collections) {
    logger.log(`Dropping collection ${collection.collectionName}`);
    await collection.drop();
  }
  await mongoose.connection.db!.dropDatabase();
};
