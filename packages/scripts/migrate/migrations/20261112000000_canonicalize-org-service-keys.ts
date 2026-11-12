import { randomUUID } from 'node:crypto';
import { ApiKeyStatus, CreditHolderType, orgServiceAccountEmail } from '@bike4mind/common';
import { mongoose } from '@bike4mind/database';
import { z } from 'zod';
import type { MigrationFile } from './index';

const objectId = z.string().regex(/^[a-f\d]{24}$/i);
const legacyAccount = z.object({
  organizationId: objectId,
  createdByUserId: objectId,
  grants: z
    .array(
      z.discriminatedUnion('resourceType', [
        z
          .object({ resourceType: z.literal('organization'), resourceId: objectId, permission: z.literal('compute') })
          .strict(),
        z.object({ resourceType: z.literal('project'), resourceId: objectId, permission: z.literal('read') }).strict(),
      ])
    )
    .min(1)
    .max(25),
});

const migration: MigrationFile = {
  id: 20261112000000,
  name: 'canonicalize organization service keys',
  up: async () => {
    const db = mongoose.connection.db;
    if (!db) throw new Error('Service key migration requires a database');
    const keys = db.collection('userapikeys');
    const users = db.collection('users');
    const cursor = keys.find({ serviceAccount: true });
    try {
      for await (const key of cursor) {
        await db
          .collection('connections')
          .updateMany({ apiKeyId: String(key._id), endedAt: null }, { $set: { endedAt: new Date() } });
        const holder = mongoose.isObjectIdOrHexString(key.userId)
          ? await users.findOne({ _id: new mongoose.Types.ObjectId(key.userId) })
          : null;
        const parsed = legacyAccount.safeParse(holder?.orgServiceAccount);
        let valid =
          parsed.success &&
          holder?.isSystem === true &&
          holder.isAdmin !== true &&
          key.billingOwnerType === CreditHolderType.Organization &&
          key.organizationId === parsed.data.organizationId &&
          !key.orgOwned;
        const account = parsed.success ? parsed.data : null;
        const org =
          valid && account
            ? await db
                .collection('organizations')
                .findOne({ _id: new mongoose.Types.ObjectId(account.organizationId), deletedAt: null })
            : null;
        valid = valid && !!org;
        if (valid && account) {
          for (const grant of account.grants) {
            if (grant.resourceType === 'organization') valid = valid && grant.resourceId === account.organizationId;
            else
              valid =
                valid &&
                !!(await db.collection('projects').findOne({
                  _id: new mongoose.Types.ObjectId(grant.resourceId),
                  organizationId: account.organizationId,
                  deletedAt: null,
                }));
          }
        }
        if (valid && account && org) {
          const email = orgServiceAccountEmail(account.organizationId);
          await users.updateOne(
            { email },
            {
              $setOnInsert: {
                email,
                username: `org-service-account-${randomUUID()}`,
                name: 'Organization service account',
                isSystem: true,
                isAdmin: false,
                serviceAccountOrganizationId: account.organizationId,
              },
            },
            { upsert: true }
          );
          const canonical = await users.findOne({
            email,
            isSystem: true,
            isAdmin: { $ne: true },
            serviceAccountOrganizationId: account.organizationId,
          });
          if (!canonical) throw new Error('Canonical service account does not match its organization');
          await db
            .collection('organizations')
            .updateOne({ _id: org._id }, { $set: { serviceAccountUserId: String(canonical._id) } });
          await keys.updateOne(
            { _id: key._id, serviceAccount: true },
            {
              $set: {
                userId: String(canonical._id),
                orgOwned: { createdByUserId: account.createdByUserId, grants: account.grants },
              },
              $unset: { serviceAccount: '' },
            }
          );
        } else {
          await keys.updateOne(
            { _id: key._id, serviceAccount: true },
            {
              $set: {
                status: ApiKeyStatus.DISABLED,
                revokedAt: key.revokedAt ?? new Date(),
                revokedReason: 'Service account binding unavailable',
              },
              $unset: { serviceAccount: '' },
            }
          );
        }
      }
    } finally {
      await cursor.close();
    }
    await users.updateMany({ orgServiceAccount: { $exists: true } }, { $unset: { orgServiceAccount: '' } });
  },
  down: async () => {
    throw new Error('Canonical service key migration cannot be reversed safely');
  },
};

export default migration;
