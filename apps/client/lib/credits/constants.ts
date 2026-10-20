/**
 * Client-specific pricing configuration.
 * Other deployments may use different pricing and plans.
 */

import { MIN_PRICE_PER_CREDIT_USD } from '@bike4mind/common';
import { CreditPackageId } from './types';

type CreditPackage<K extends CreditPackageId = CreditPackageId> = {
  id: K;
  price: number;
  description: string;
  credits: number;
  isBestValue?: boolean;
};

// Every package grants credits at the platform sale rate ($0.0006/credit by default), so every
// buyer experiences the same markup over provider cost regardless of pack size. Credits are derived
// from the price, never typed, so a repricing cannot leave a pack off the rate.
const creditsForPrice = (price: number) => Math.round(price / MIN_PRICE_PER_CREDIT_USD);

const creditPackage = <K extends CreditPackageId>(id: K, price: number, description: string): CreditPackage<K> => ({
  id,
  price,
  credits: creditsForPrice(price),
  description,
});

// No isBestValue badge: every package sells credits at the same uniform rate, so no pack is a
// better deal than another - only bigger.
export const CREDIT_PACKAGES: { [key in CreditPackageId]: CreditPackage<key> } = {
  [CreditPackageId.Usd20]: creditPackage(CreditPackageId.Usd20, 20, 'Starter package for occasional use'),
  [CreditPackageId.Usd50]: creditPackage(CreditPackageId.Usd50, 50, 'Standard package for steady use'),
  [CreditPackageId.Usd100]: creditPackage(CreditPackageId.Usd100, 100, 'Largest package for heavy use'),
};
