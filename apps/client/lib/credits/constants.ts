/**
 * Client-specific pricing configuration.
 * Other deployments may use different pricing and plans.
 */

import { CreditPackageId } from './types';

// Every package grants credits at the same uniform rate ($0.0006/credit,
// matching USD_TO_CREDITS_RATE in @bike4mind/common pricing.ts) so every
// buyer experiences the same markup over provider cost regardless of pack
// size. Keep these in sync with that anchor when repricing.
export const CREDIT_PACKAGES: {
  [key in CreditPackageId]: {
    id: key;
    price: number;
    description: string;
    credits: number;
    isBestValue?: boolean;
  };
} = {
  [CreditPackageId.A]: {
    id: CreditPackageId.A,
    price: 10,
    credits: 16667,
    description: 'Starter package for occasional use',
  },
  [CreditPackageId.B]: {
    id: CreditPackageId.B,
    price: 20,
    credits: 33333,
    description: 'Standard package for steady use',
  },
  [CreditPackageId.C]: {
    id: CreditPackageId.C,
    price: 35,
    credits: 58333,
    // No isBestValue badge: every package sells credits at the same uniform
    // rate, so no pack is a better deal than another - only bigger.
    description: 'Largest package for heavy use',
  },
};
