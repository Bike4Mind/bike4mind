import mongoose from 'mongoose';

export interface DuplicateOrganizationCustomer {
  stripeCustomerId: string;
  count: number;
  organizations: { organizationId: string; deleted: boolean }[];
}

export async function auditOrganizationStripeCustomers(): Promise<DuplicateOrganizationCustomer[]> {
  // Raw collection includes tombstones; model middleware would hide historical duplicates.
  return mongoose.connection
    .collection('organizations')
    .aggregate<DuplicateOrganizationCustomer>([
      {
        $match: {
          $expr: { $eq: [{ $type: '$stripeCustomerId' }, 'string'] },
          stripeCustomerId: { $ne: '' },
        },
      },
      { $sort: { _id: 1 } },
      {
        $group: {
          _id: '$stripeCustomerId',
          count: { $sum: 1 },
          organizations: {
            $push: {
              organizationId: { $toString: '$_id' },
              deleted: { $ne: [{ $ifNull: ['$deletedAt', null] }, null] },
            },
          },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $sort: { _id: 1 } },
      { $project: { _id: 0, stripeCustomerId: '$_id', count: 1, organizations: 1 } },
    ])
    .toArray();
}
