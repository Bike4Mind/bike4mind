import mongoose, { type Connection } from 'mongoose';
import type { IUsageEventInput } from '@bike4mind/common';
import { User } from '../models/auth/UserModel';
import { Organization } from '../models/infra/admin/OrganizationModel';
import { UsageEvent, type IUsageEventDocument } from '../models/billing/UsageEventModel';

type CollectionModel = { db: Connection; collection: { name: string } };

function connectedCollection(model: CollectionModel) {
  if (model.db.readyState !== 1 || !model.db.db) {
    throw new Error('Operational usage persistence requires an established database connection');
  }
  return model.db.db.collection(model.collection.name);
}

async function findIdentity(
  model: CollectionModel,
  id: string,
  timeoutMS: number,
  filter: Record<string, unknown> = {}
): Promise<{ id: string } | null> {
  if (!mongoose.isObjectIdOrHexString(id)) return null;
  const result = await connectedCollection(model).findOne(
    { ...filter, _id: new mongoose.Types.ObjectId(id) },
    { projection: { _id: 1 }, timeoutMS }
  );
  return result ? { id: result._id.toHexString() } : null;
}

export function createBoundedZeroCreditOperationalUsageStore({
  lookupTimeoutMS,
  writeTimeoutMS,
}: {
  lookupTimeoutMS: number;
  writeTimeoutMS: number;
}) {
  for (const timeout of [lookupTimeoutMS, writeTimeoutMS]) {
    if (!Number.isSafeInteger(timeout) || timeout <= 0) {
      throw new RangeError('Operational usage persistence requires positive integer timeouts');
    }
  }

  return {
    findUserById: (id: string) => findIdentity(User, id, lookupTimeoutMS),
    findOrganizationById: (id: string) => findIdentity(Organization, id, lookupTimeoutMS, { deletedAt: null }),
    usageEvents: {
      async record(event: IUsageEventInput): Promise<IUsageEventDocument> {
        if (event.creditsCharged !== 0)
          throw new Error('Operational usage persistence permits only zero-credit events');
        const document = new UsageEvent(event);
        const now = new Date();
        document.set({ createdAt: now, updatedAt: now, __v: 0 });
        const validationError = document.validateSync();
        if (validationError) throw validationError;
        // Mongoose save drops timeoutMS and may buffer; native operations preserve the driver deadline.
        await connectedCollection(UsageEvent).insertOne(document.toObject({ virtuals: false }), {
          timeoutMS: writeTimeoutMS,
        });
        return document.toObject();
      },
    },
  };
}
