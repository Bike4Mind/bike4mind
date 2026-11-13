import { connectDB, Organization } from '@bike4mind/database';
import { Config } from '@bike4mind/server-utils/utils/config';
import { Resource } from 'sst';
import { cleanupOrganizationRetention } from '@server/organizations/retentionCleanup';

export async function handler() {
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage));
  return runOrganizationRetention();
}

export async function runOrganizationRetention() {
  const deadline = Date.now() + 120_000;
  const organizations = await Organization.find({ personal: false, retentionVersion: { $gt: 0 } })
    .sort({ retentionLastSweptAt: 1, _id: 1 })
    .limit(20)
    .maxTimeMS(5000);
  let failures = 0;
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
  if (failures) throw new Error(`Organization retention failed for ${failures} organization(s)`);
}
