import { retentionKinds } from '@bike4mind/common';
import { connectDB, Organization } from '@bike4mind/database';
import { Config } from '@bike4mind/server-utils/utils/config';
import { Resource } from 'sst';
import { retryGeneratedFileCleanup } from '@bike4mind/server-utils/utils/generatedFileCleanup';
import { cleanupOrganizationRetention } from '@workers/organizations/retentionCleanup';

export const organizationRetentionFilter = {
  personal: false,
  retentionVersion: { $gt: 0 },
  $or: retentionKinds.map(kind => ({ [`retentionPolicy.${kind}`]: { $gte: 1, $lte: 36500 } })),
};

export async function handler() {
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage));
  return runOrganizationRetention();
}

export async function runOrganizationRetention() {
  const deadline = Date.now() + 120_000;
  let failures = 0;
  let fileCleanupFailed = false;
  try {
    await retryGeneratedFileCleanup({ deadline });
  } catch {
    fileCleanupFailed = true;
  }
  const organizations = await Organization.find(organizationRetentionFilter)
    .sort({ retentionLastSweptAt: 1, _id: 1 })
    .limit(20)
    .maxTimeMS(5000);
  for (const org of organizations) {
    if (Date.now() >= deadline) break;
    try {
      await cleanupOrganizationRetention(org.id, { deadline });
    } catch {
      failures++;
    } finally {
      await Organization.updateOne({ _id: org._id }, { $set: { retentionLastSweptAt: new Date() } });
    }
  }
  if (failures || fileCleanupFailed)
    throw new Error(
      `Organization retention failed for ${failures} organization(s) and ${fileCleanupFailed ? 1 : 0} generated Files cleanup batch(es)`
    );
}
