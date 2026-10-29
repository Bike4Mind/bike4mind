import { CreditHolderType, type FundingLotLike } from '@bike4mind/common';
import { User } from '../auth/UserModel';
import { Organization } from '../infra/admin/OrganizationModel';
import { Agent } from '../ai/AgentModel';
import { creditLotRepository } from './CreditLotModel';

/** A holder's lots (sorted soonest-expiry-first) and live balance: the inputs to attributeChargeToFundingSources. */
export type CreditHolderFundingSnapshot = {
  lots: FundingLotLike[];
  currentCredits: number;
};

export type LoadCreditHolderFundingSnapshot = (
  ownerId: string,
  ownerType: CreditHolderType
) => Promise<CreditHolderFundingSnapshot>;

async function findHolder(ownerId: string, ownerType: CreditHolderType) {
  const projection = { currentCredits: 1 };
  switch (ownerType) {
    case CreditHolderType.Organization:
      return Organization.findById(ownerId, projection).lean();
    case CreditHolderType.Agent:
      return Agent.findById(ownerId, projection).lean();
    case CreditHolderType.User:
      return User.findById(ownerId, projection).lean();
  }
}

// A missing holder must not read as a zero balance: that would mark every lot consumed and
// stamp the charge against the latest-expiring lot. Throwing leaves the row unstamped.
async function findHolderBalance(ownerId: string, ownerType: CreditHolderType): Promise<number> {
  const holder = await findHolder(ownerId, ownerType);
  if (!holder) {
    throw new Error(`Credit holder ${ownerType} ${ownerId} not found`);
  }
  return holder.currentCredits ?? 0;
}

export const loadCreditHolderFundingSnapshot: LoadCreditHolderFundingSnapshot = async (ownerId, ownerType) => {
  const lots = await creditLotRepository.findByOwner(ownerId, ownerType);
  // No lots means nothing to attribute to, so skip the balance read.
  if (lots.length === 0) {
    return { lots: [], currentCredits: 0 };
  }
  return { lots, currentCredits: await findHolderBalance(ownerId, ownerType) };
};
