/**
 * Interface for entities that can hold and manage credits
 */
export interface ICreditHolder {
  /**
   * Current available credits
   */
  currentCredits: number;

  /**
   * Timestamp when credits were last purchased/updated
   * This is an optional field and is not required for all credit holders
   */
  lastCreditsPurchasedAt?: Date | null;
}

/**
 * Interface of Credit Holder methods
 */
export interface ICreditHolderMethods {
  incrementCredits: ICreditHolderIncrementer;
}

export type ICreditHolderIncrementer = (
  ownerId: string,
  credits: number,
  options?: {
    /** Update the last credits purchased at timestamp */
    updateLastCreditsPurchasedAt?: boolean;
  }
) => Promise<ICreditHolder | null>;

/**
 * Debit up to `credits` in one atomic update without taking the balance below zero (a balance that is
 * already negative is left as is). Resolves the credits actually debited, so a caller can see a shortfall.
 */
export interface ICreditHolderFlooredDebit {
  decrementCreditsFloored(ownerId: string, credits: number): Promise<number>;
}

export enum CreditHolderType {
  User = 'User',
  Organization = 'Organization',
  Agent = 'Agent',
}

/**
 * Credit holder entity identifier for multi-tenant operations
 */
export interface ICreditHolderIdentifier {
  /**
   * The ID of the entity (user ID or organization ID)
   */
  id: string;

  /**
   * The type of entity
   */
  type: CreditHolderType;
}

/**
 * Type guard to check if an entity implements ICreditHolder
 */
export function isCreditHolder(entity: unknown): entity is ICreditHolder {
  if (typeof entity !== 'object' || entity === null) return false;
  const e = entity as Partial<ICreditHolder>;
  return (
    typeof e.currentCredits === 'number' &&
    (e.lastCreditsPurchasedAt === null ||
      e.lastCreditsPurchasedAt === undefined ||
      e.lastCreditsPurchasedAt instanceof Date)
  );
}

/**
 * Credits moved out of an owner's balance ahead of a paid provider call. Plain JSON-serializable
 * data, so a job document can carry it and a different process can settle or release it.
 * Produced by @bike4mind/services holdCredits (exported there as CreditHold).
 */
export type CreditHoldRecord = {
  ownerId: string;
  ownerType: CreditHolderType.User | CreditHolderType.Organization;
  /** The actor: attribution and per-member usage tracking, even when the org pays. */
  userId: string;
  organizationId: string | null;
  reservedCredits: number;
  /** The owner's balance right after the hold; the ledger row's balance when no refund lands. */
  balanceAfterHold: number;
};

/**
 * A hold persisted for a later request to settle, with the id of the PendingCreditHold row the
 * expired-hold sweep refunds. Settling claims that row, so settle and sweep can never both move
 * balance. Absent on records written before the row existed; those settle directly.
 */
export type PersistedCreditHold = CreditHoldRecord & { pendingHoldId?: string };
