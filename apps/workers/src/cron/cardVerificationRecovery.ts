import { connectDB } from '@bike4mind/database';
import { Config } from '@bike4mind/server-utils/utils/config';
import { ensureCardVerificationIndexes, reconcileCardVerifications } from '@server/billing/cardVerificationRuntime';
import { Resource } from 'sst';

export async function handler(): Promise<void> {
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage), undefined, {
    autoIndex: false,
    autoCreate: false,
  });
  await ensureCardVerificationIndexes();
  await reconcileCardVerifications();
}
