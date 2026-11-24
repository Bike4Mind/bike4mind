import mongoose, { type Connection, type Model } from 'mongoose';
import type { IOrganizationDocument, IUsageEventInput, IUserDocument } from '@bike4mind/common';
import { User } from '../models/auth/UserModel';
import { Organization } from '../models/infra/admin/OrganizationModel';
import { UsageEvent, type IUsageEventDocument } from '../models/billing/UsageEventModel';

function connectedCollection(model: { db: Connection; collection: { name: string } }) {
  if (model.db.readyState !== 1 || !model.db.db) {
    throw new Error('Operational usage persistence requires an established database connection');
  }
  return model.db.db.collection(model.collection.name);
}

async function findIdentity<T>(
  model: Model<T>,
  id: string,
  timeoutMS: number,
  filter: Record<string, unknown> = {}
): Promise<T | null> {
  if (!mongoose.isObjectIdOrHexString(id)) return null;
  const result = await connectedCollection(model).findOne(
    { ...filter, _id: new mongoose.Types.ObjectId(id) },
    { projection: { _id: 1 }, timeoutMS }
  );
  return result ? (model.hydrate(result, { _id: 1 }).toJSON() as T) : null;
}

export function createBoundedOperationalUsageStore({
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
    findUserById: (id: string): Promise<IUserDocument | null> => findIdentity(User, id, lookupTimeoutMS),
    findOrganizationById: (id: string): Promise<IOrganizationDocument | null> =>
      findIdentity(Organization, id, lookupTimeoutMS, { deletedAt: null }),
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
