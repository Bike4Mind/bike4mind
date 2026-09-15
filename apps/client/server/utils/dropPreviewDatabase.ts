import { MongoClient } from 'mongodb';
import { Resource } from 'sst';

interface DropDatabaseInput {
  action: string;
  stage: string;
  isPreview?: boolean;
  timestamp?: number;
}

interface DropDatabaseResult {
  statusCode: number;
  message?: string;
  error?: string;
}

// Uses MongoClient directly instead of @bike4mind/database to avoid importing
// Mongoose models. The barrel export registers all models, and connectDB
// uses autoIndex: true, which races with dropDatabase() to recreate
// collections via background index builds.
export const handler = async (event: DropDatabaseInput): Promise<DropDatabaseResult> => {
  const stage = event.stage || Resource.App.stage;

  // Safety: only allow dropping pr<digits> databases (e.g. pr123, pr456)
  // Regex ensures 'production' and other non-preview stages are rejected
  if (!/^pr\d+$/.test(stage)) {
    return { statusCode: 400, error: `Refused to drop database for non-preview stage: ${stage}` };
  }

  // Safety: MONGODB_URI must contain %STAGE% placeholder
  const uri = Resource.MONGODB_URI.value;
  if (!uri.includes('%STAGE%')) {
    return { statusCode: 400, error: 'MONGODB_URI does not contain %STAGE% placeholder' };
  }

  const resolvedUri = uri.replaceAll('%STAGE%', stage);
  console.log(`Dropping database for stage: ${stage}`);

  const client = new MongoClient(resolvedUri, {
    serverSelectionTimeoutMS: 30000,
    connectTimeoutMS: 30000,
  });

  try {
    await client.connect();
    const db = client.db();

    const collections = await db.collections();
    for (const collection of collections) {
      console.log(`Dropping collection: ${collection.collectionName}`);
      await collection.drop();
    }

    await db.dropDatabase();
    console.log(`Database cleanup completed for stage: ${stage}`);
    return { statusCode: 200, message: `Dropped database for ${stage}` };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Database cleanup failed:', error);
    return { statusCode: 500, error: errorMessage };
  } finally {
    await client.close().catch(() => {});
  }
};
