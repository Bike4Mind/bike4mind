import { spendFrozenError, type ISpendFreezeRepository, type SpendFreezeSubject } from '@bike4mind/common';

/** Throws the tagged `spend_frozen` error when any scope the subject spends under is frozen. */
export const assertSpendNotFrozen = async (
  subject: SpendFreezeSubject,
  adapters: { db: { spendFreezes: Pick<ISpendFreezeRepository, 'findActiveForSubject'> } }
): Promise<void> => {
  const freeze = await adapters.db.spendFreezes.findActiveForSubject(subject);
  if (freeze) throw spendFrozenError(freeze);
};
