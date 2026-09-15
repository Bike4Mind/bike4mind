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
export function isCreditHolder(entity: any): entity is ICreditHolder {
  return (
    entity &&
    typeof entity.currentCredits === 'number' &&
    (entity.lastCreditsPurchasedAt === null ||
      entity.lastCreditsPurchasedAt === undefined ||
      entity.lastCreditsPurchasedAt instanceof Date)
  );
}
