import { BillingEventModel } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Ensure the BillingEvent indexes exist: the unique `stripeEventId` and the two Timeline read indexes.
 *
 * The Stripe webhook upserts on `stripeEventId`, and only the unique index keeps two concurrent
 * deliveries of one event from inserting two rows. Left to autoIndex, the build is fire-and-forget:
 * a duplicate written first makes it fail silently, and the constraint never exists. Id backdated
 * below BackfillOAuthClientTokenEndpointAuthMethod (20260922000001), like its index-migration siblings.
 *
 * Idempotent: createIndexes is a no-op for indexes that already exist.
 */
const migration: MigrationFile = {
  id: 20260921240030,
  name: 'ensure billing event indexes',

  up: async () => {
    await BillingEventModel.createIndexes();
  },

  down: async () => {
    // Indexes are additive, and dropping the unique one would let a redelivery duplicate an event.
  },
};

export default migration;
