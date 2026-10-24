import { pathToFileURL } from 'node:url';
import { connectDB, whenCatalogSeeded } from '@bike4mind/database';
import { Resource } from 'sst';
import mongoose from 'mongoose';
import { protectStoredCredentials } from './protect-stored-credentials-backfill';

async function run(): Promise<void> {
  if (!process.argv.includes('--maintenance-window')) {
    throw new Error(
      'Stop traffic and legacy workers, deploy compatible readers, then pass --maintenance-window. See docs/security/credential-storage.md'
    );
  }
  const uri = Resource.MONGODB_URI.value.replace('%STAGE%', Resource.App.stage);
  await connectDB(uri);
  try {
    await protectStoredCredentials();
    console.info('Credential backfill completed. Repeat the command to verify convergence before resuming writers.');
  } finally {
    // connectDB kicks off a fire-and-forget catalog seed; disconnecting under it throws
    // MongoExpiredSessionError after the real result is printed. whenCatalogSeeded never rejects.
    await whenCatalogSeeded().catch(() => {});
    await mongoose.disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Credential backfill failed');
    process.exitCode = 1;
  });
}
