import mongoose from 'mongoose';
import { OrgDomainClaim } from '@bike4mind/database';
import ensureOwnerIndexes from './20261115093000_ensure-domain-claim-owner-indexes';
import type { MigrationFile } from './index';

const legacyName = 'organizationId_1_domain_1';

const migration: MigrationFile = {
  id: 20261117212931,
  name: 'drop legacy domain claim org index',
  up: async () => {
    // The replacements must exist before the legacy index is removed.
    await ensureOwnerIndexes.up();
    const indexes = await OrgDomainClaim.collection.indexes();
    const existing = indexes.find(index => index.name === legacyName);
    if (!existing) return;
    if (
      JSON.stringify(existing.key) !== JSON.stringify({ organizationId: 1, domain: 1 }) ||
      existing.unique !== true ||
      existing.partialFilterExpression !== undefined ||
      existing.sparse === true ||
      existing.collation !== undefined ||
      existing.expireAfterSeconds !== undefined ||
      existing.hidden === true
    )
      throw new Error(`Refusing to drop an unrecognized legacy index: ${legacyName}`);
    try {
      await OrgDomainClaim.collection.dropIndex(legacyName);
    } catch (error) {
      if (!(error instanceof mongoose.mongo.MongoServerError) || error.code !== 27) throw error;
    }
  },
  // Do not recreate the legacy index: it cannot tell Space claims apart.
  down: async () => {},
};
export default migration;
