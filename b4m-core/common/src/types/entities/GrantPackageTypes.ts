/**
 * A named signup grant (credits, storage, tags) that invite codes point at, with optional caps on
 * how many accounts may redeem it in total and per UTC day. A null cap means unlimited.
 */
export interface IGrantPackage {
  name: string;
  credits: number;
  storageMb?: number | null;
  tags?: string[];
  totalCap: number | null;
  dailyCap: number | null;
  redeemedTotal: number;
  /** Redemptions refused because a cap was reached, so an admin can see the cap biting. */
  capHits: number;
  lastCapHitAt?: Date | null;
  active: boolean;
  createdBy: string;
  reason?: string | null;
  /**
   * Set only by the invite migration: the package stands in for an invite's own amounts and keeps
   * the pre-package signup rules (see register.ts), so migrated codes behave exactly as before.
   */
  legacy?: boolean;
}

export interface IGrantPackageDocument extends IGrantPackage {
  id: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export type GrantPackageRefusalReason = 'total_cap' | 'daily_cap' | 'inactive';

/**
 * `already` means this account redeemed the package earlier (a retried signup), so it is not
 * counted twice; its release is a no-op so a retry never hands back the original redemption.
 */
export type GrantPackageReservation =
  | { outcome: 'reserved' | 'already'; release: () => Promise<void> }
  | { outcome: 'refused'; reason: GrantPackageRefusalReason };

export interface IGrantPackageRepository {
  findById: (id: string) => Promise<IGrantPackageDocument | null>;
  /**
   * Count one redemption of the package by `userId` against its caps. Joins the ambient
   * transaction (mongoose transactionAsyncLocalStorage), so a rolled-back signup frees its slot;
   * a refusal's cap-hit counter is written outside it so it survives that rollback.
   */
  reserveRedemption: (packageId: string, userId: string, now?: Date) => Promise<GrantPackageReservation>;
  /** Undo `userId`'s redemption, if any. Idempotent. */
  releaseRedemption: (packageId: string, userId: string) => Promise<void>;
  /** True when another account already claimed a signup grant for this canonical inbox. */
  isInboxClaimed: (canonicalEmail: string) => Promise<boolean>;
}
