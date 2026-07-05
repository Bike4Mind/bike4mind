/**
 * Client-specific pricing configuration.
 * Other deployments may use different pricing and plans.
 */

import { CreditPackageId } from './types';

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
    credits: 10000,
    description: 'Basic package for occasional use',
  },
  [CreditPackageId.B]: {
    id: CreditPackageId.B,
    price: 20,
    credits: 25000,
    description: 'Standard package with better value',
  },
  [CreditPackageId.C]: {
    id: CreditPackageId.C,
    price: 35,
    credits: 50000,
    description: 'Best value for regular users',
    isBestValue: true,
  },
};
