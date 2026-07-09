import { CreditHolderType, CreditLotSource, dayjs, ICreditLotRepository } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';

/**
 * The subset of addCredits grant types (plus the migration's 'legacy'
 * backfill) that a lot can be stamped for. Maps 1:1 to a CreditLotSource and
 * an expiry policy - see EXPIRY_MONTHS_BY_GRANT_TYPE below.
 */
export type CreditLotGrantType = 'purchase' | 'subscription' | 'generic_add' | 'received_credit' | 'legacy';

const SOURCE_BY_GRANT_TYPE: Record<CreditLotGrantType, CreditLotSource> = {
  purchase: 'pack',
  subscription: 'subscription',
  generic_add: 'promo',
  received_credit: 'transfer',
  legacy: 'legacy',
};

// Pack purchases and the legacy backfill get a full year; every other grant
// type (subscription, promo/signup, transfer) gets 90 days.
const TWELVE_MONTH_GRANT_TYPES = new Set<CreditLotGrantType>(['purchase', 'legacy']);

function expiresAtForGrantType(grantType: CreditLotGrantType, now: Date): Date {
  return TWELVE_MONTH_GRANT_TYPES.has(grantType)
    ? dayjs(now).add(12, 'month').toDate()
    : dayjs(now).add(90, 'day').toDate();
}

export interface StampCreditLotParams {
  ownerId: string;
  ownerType: CreditHolderType;
  amount: number;
  grantType: CreditLotGrantType;
  stripeRef?: string;
  now?: Date;
}

export interface StampCreditLotAdapters {
  db: {
    creditLots: ICreditLotRepository;
  };
}

/**
 * Stamp a CreditLot for a grant. Best-effort by design: a failure here must
 * never fail the grant that triggered it - drift self-heals via the daily
 * sweep's `C = max(0, ΣlotAmount - currentCredits)` clamp.
 */
export async function stampCreditLot(params: StampCreditLotParams, { db }: StampCreditLotAdapters): Promise<void> {
  try {
    const now = params.now ?? new Date();
    await db.creditLots.create({
      ownerId: params.ownerId,
      ownerType: params.ownerType,
      source: SOURCE_BY_GRANT_TYPE[params.grantType],
      amount: params.amount,
      expiresAt: expiresAtForGrantType(params.grantType, now),
      consumedAssigned: 0,
      stripeRef: params.stripeRef,
    });
  } catch (err) {
    Logger.error('Failed to stamp credit lot', err, {
      ownerId: params.ownerId,
      ownerType: params.ownerType,
      grantType: params.grantType,
    });
  }
}
