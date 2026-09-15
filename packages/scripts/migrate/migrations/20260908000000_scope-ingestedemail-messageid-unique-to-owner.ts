import { IngestedEmailModel } from '@bike4mind/database/infra';
import { safeDropIndex } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Replace the global `messageId_1` unique index on `ingestedemails` with `{ messageId, userId }`.
 *
 * A Message-ID is chosen by the sending mail system, not by us, so it is unique per SENDER and not
 * across tenants: redirect-style forwarding preserves it, and a deliberate replay can pre-claim
 * one. With the idempotency lookup now scoped to the owner, a global constraint turns the second
 * tenant's delivery into an E11000 that the SQS handler can only retry and DLQ - the message is
 * lost. Per-owner uniqueness keeps the retry idempotency it was there for.
 *
 * The replacement is partial on live rows: softDeletePlugin hides a deleted row from the lookup,
 * so a full index would let it keep blocking a re-delivery the lookup reports as new.
 *
 * Dropping first: the two key patterns do not conflict, but leaving `messageId_1` in place would
 * keep enforcing exactly the constraint this removes.
 */
const migration: MigrationFile = {
  id: 20260908000000,
  name: 'scope ingestedemail messageId uniqueness to the owner',

  up: async () => {
    // Tolerates an already-absent index, so a fresh environment that never built it is fine.
    await safeDropIndex(IngestedEmailModel.collection, 'messageId_1');
    // Builds every index the schema declares, including the new compound one. Idempotent.
    await IngestedEmailModel.createIndexes();
    console.log('ingestedemails: messageId uniqueness is now scoped to { messageId, userId }');
  },

  down: async () => {
    // Intentional no-op. Restoring the global constraint would reintroduce the cross-tenant
    // collision, and it can fail outright once two owners legitimately hold the same Message-ID.
  },
};

export default migration;
