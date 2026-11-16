import mongoose from 'mongoose';
import { z } from 'zod';
import { FabFile, Organization, Session } from '@bike4mind/database';
import ensureRetentionIndexes from './20261113185006_ensure-organization-retention-erasure-indexes';
import type { MigrationFile } from './index';

const legacyPartialSchema = z.record(
  z.string(),
  z.object({ $type: z.union([z.literal('string'), z.literal(2)]) }).strict()
);

function sameLegacyPartial(actual: unknown, expected: unknown): boolean {
  if (expected === undefined) return actual === undefined;
  const parsed = legacyPartialSchema.safeParse(actual);
  const wanted = legacyPartialSchema.safeParse(expected);
  if (!parsed.success || !wanted.success) return false;
  // MongoDB can report the BSON string type as either its name or numeric code.
  return JSON.stringify(Object.keys(parsed.data).sort()) === JSON.stringify(Object.keys(wanted.data).sort());
}

const obsoleteIndexes = [
  {
    collection: Session.collection,
    name: 'retention_sessions_partial',
    key: { retentionOrganizationId: 1, deletedAt: 1, _id: 1 },
    partial: { retentionOrganizationId: { $type: 'string' } },
  },
  {
    collection: FabFile.collection,
    name: 'retention_files_partial',
    key: { organizationId: 1, deletedAt: 1, createdAt: 1, _id: 1 },
    partial: { organizationId: { $type: 'string' } },
  },
  {
    collection: FabFile.collection,
    name: 'sourceMetadata.retentionOrganizationId_1_deletedAt_1_createdAt_1__id_1',
    key: { 'sourceMetadata.retentionOrganizationId': 1, deletedAt: 1, createdAt: 1, _id: 1 },
    partial: { 'sourceMetadata.retentionOrganizationId': { $type: 'string' } },
  },
  {
    collection: Organization.collection,
    name: 'personal_1_retentionLastSweptAt_1__id_1',
    key: { personal: 1, retentionLastSweptAt: 1, _id: 1 },
    partial: undefined,
  },
] as const;

const migration: MigrationFile = {
  id: 20261114101042,
  name: 'drop obsolete organization retention indexes',
  up: async () => {
    // This immutable predecessor only ensures indexes. Finish every replacement before removing any old one.
    await ensureRetentionIndexes.up();
    const removals = [];
    for (const spec of obsoleteIndexes) {
      const indexes = await spec.collection.indexes();
      const existing = indexes.find(index => index.name === spec.name);
      if (!existing) continue;
      if (
        JSON.stringify(existing.key) !== JSON.stringify(spec.key) ||
        !sameLegacyPartial(existing.partialFilterExpression, spec.partial) ||
        existing.unique === true ||
        existing.sparse === true ||
        existing.collation !== undefined ||
        existing.expireAfterSeconds !== undefined ||
        existing.hidden === true
      )
        throw new Error(`Refusing to drop an unrecognized legacy index: ${spec.name}`);
      removals.push({ collection: spec.collection, name: spec.name });
    }
    for (const { collection, name } of removals) {
      try {
        await collection.dropIndex(name);
      } catch (error) {
        if (!(error instanceof mongoose.mongo.MongoServerError) || error.code !== 27) throw error;
      }
    }
  },
  // Do not recreate unsuitable indexes or remove their serving replacements on rollback.
  down: async () => {},
};
export default migration;
