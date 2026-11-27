import { randomUUID } from 'crypto';
import mongoose from 'mongoose';
import { MigrationLock } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';

export const MIGRATION_LOCK_ID = 'migrator';

// The migrator Lambda times out at 15 minutes (infra/database.ts) and a timed-out run never reaches
// its release, so a crashed run must not block the next deploy for long. Renewing every minute keeps
// a 5-minute lease alive through four missed renewals (a slow network or a busy event loop), while a
// dead run frees the lock within 5 minutes.
export const LEASE_DURATION_MS = 5 * 60 * 1000;
export const LEASE_RENEW_INTERVAL_MS = 60 * 1000;

const DUPLICATE_KEY_ERROR = 11000;

export type LeaseOptions = {
  leaseDurationMs?: number;
  renewIntervalMs?: number;
};

export class MigrationLease {
  private expiresAt: Date;
  private lost = false;
  private renewal: Promise<void> = Promise.resolve();
  private readonly timer: NodeJS.Timeout;

  constructor(
    readonly owner: string,
    expiresAt: Date,
    private readonly leaseDurationMs: number,
    renewIntervalMs: number,
    private readonly logger: Logger
  ) {
    this.expiresAt = expiresAt;
    this.timer = setInterval(() => {
      this.renewal = this.renewal.then(() => this.renew());
    }, renewIntervalMs);
    this.timer.unref();
  }

  /** True once another run has taken the lease, or this run failed to renew it before it expired. */
  isLost(): boolean {
    return this.lost || Date.now() >= this.expiresAt.getTime();
  }

  async release(): Promise<void> {
    clearInterval(this.timer);
    await this.renewal;
    await MigrationLock.deleteOne({ _id: MIGRATION_LOCK_ID, owner: this.owner });
  }

  private async renew(): Promise<void> {
    if (this.lost) return;
    const expiresAt = new Date(Date.now() + this.leaseDurationMs);
    try {
      const result = await MigrationLock.updateOne(
        { _id: MIGRATION_LOCK_ID, owner: this.owner },
        { $set: { expiresAt } },
        { runValidators: true }
      );
      if (result.matchedCount === 0) {
        this.lost = true;
        this.logger.error(`Migration lease ${this.owner} was taken over by another run`);
        return;
      }
      this.expiresAt = expiresAt;
    } catch (error: unknown) {
      // Transient: the next tick retries, and isLost() turns true if the lease runs out first.
      this.logger.warn(`Failed to renew migration lease ${this.owner}`, error);
    }
  }
}

/**
 * Takes the single migration-runner lease, or returns null when a live lease is held by another
 * run. One atomic upsert: it matches only an expired lease, so against a live one the insert
 * collides on `_id` and fails with a duplicate key error.
 */
export async function acquireMigrationLease(
  logger: Logger,
  { leaseDurationMs = LEASE_DURATION_MS, renewIntervalMs = LEASE_RENEW_INTERVAL_MS }: LeaseOptions = {}
): Promise<MigrationLease | null> {
  const owner = randomUUID();
  const acquiredAt = new Date();
  const expiresAt = new Date(acquiredAt.getTime() + leaseDurationMs);
  try {
    await MigrationLock.updateOne(
      { _id: MIGRATION_LOCK_ID, expiresAt: { $lte: acquiredAt } },
      { $set: { owner, acquiredAt, expiresAt } },
      { upsert: true, runValidators: true }
    );
  } catch (error: unknown) {
    if (error instanceof mongoose.mongo.MongoServerError && error.code === DUPLICATE_KEY_ERROR) return null;
    throw error;
  }
  return new MigrationLease(owner, expiresAt, leaseDurationMs, renewIntervalMs, logger);
}
