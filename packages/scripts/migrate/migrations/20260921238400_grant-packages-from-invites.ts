import { GrantPackage, RegistrationInvite } from '@bike4mind/database';
import { type MigrationFile } from './index';

const LOG = '[grant-packages-from-invites]';

export const legacyPackageName = (credits: number, storageMb: number | null) =>
  storageMb ? `Legacy: ${credits} credits, ${storageMb} MB` : `Legacy: ${credits} credits`;

/**
 * Points every invite that carries its own signup credits/storage at an uncapped package with the
 * same amounts, one package per distinct (credits, storage) pair. Referral invites are skipped:
 * register.ts never applies a package to them. startingCredits/startingStorage stay on the invite
 * and users are not touched, so a pending signup grant releases exactly as before. The packages are
 * marked legacy, so register.ts keeps the pre-package rules for these codes. Idempotent: an
 * invite that already has a grantPackageId is skipped and packages are upserted by name.
 */
const migration: MigrationFile = {
  id: 20260921238400,
  name: 'grant-packages-from-invites',

  up: async () => {
    const groups = await RegistrationInvite.collection
      .aggregate<{ _id: { credits: number | null; storage: number | null } }>([
        {
          $match: {
            grantPackageId: { $in: [null, ''] },
            source: { $ne: 'referral' },
            $or: [{ startingCredits: { $gt: 0 } }, { startingStorage: { $gt: 0 } }],
          },
        },
        { $group: { _id: { credits: '$startingCredits', storage: '$startingStorage' } } },
      ])
      .toArray();

    for (const { _id } of groups) {
      const credits = _id.credits && _id.credits > 0 ? _id.credits : 0;
      const storageMb = _id.storage && _id.storage > 0 ? _id.storage : null;
      const name = legacyPackageName(credits, storageMb);
      const pkg = await GrantPackage.findOneAndUpdate(
        { name, createdBy: 'migration' },
        {
          $setOnInsert: {
            name,
            credits,
            storageMb,
            tags: [],
            totalCap: null,
            dailyCap: null,
            active: true,
            createdBy: 'migration',
            legacy: true,
          },
        },
        { upsert: true, new: true }
      ).lean();

      const result = await RegistrationInvite.collection.updateMany(
        {
          grantPackageId: { $in: [null, ''] },
          source: { $ne: 'referral' },
          startingCredits: _id.credits ?? null,
          startingStorage: _id.storage ?? null,
        },
        { $set: { grantPackageId: String(pkg!._id) } }
      );
      console.log(`${LOG} ${name}: linked ${result.modifiedCount} invite(s)`);
    }
  },

  // No-op: an admin may have edited the packages or pointed new codes at them since.
  down: async () => {},
};

export default migration;
