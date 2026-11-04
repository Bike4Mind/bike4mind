import mongoose from 'mongoose';
import { withTransaction } from '@bike4mind/db-core';

type SessionStore = { getStore(): { session?: mongoose.mongo.ClientSession } | undefined };

/**
 * Runs `fn` in the caller's open transaction, else in a new one. A nested withTransaction opens a
 * second session that cannot see the caller's uncommitted writes, e.g. the account an invite-coded
 * OTC registration (apps/client/pages/api/otc/verify.ts) is still creating.
 */
export function inCallerTransaction<T>(fn: () => Promise<T>): Promise<T> {
  // transactionAsyncLocalStorage is a Mongoose internal missing from its public types.
  const als = (mongoose as unknown as { transactionAsyncLocalStorage?: SessionStore }).transactionAsyncLocalStorage;
  return als?.getStore()?.session?.inTransaction() ? fn() : withTransaction(fn);
}
