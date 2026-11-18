import type { ISpendFreezeRepository } from '@bike4mind/common';

export const listActiveFreezes = (
  query: Parameters<ISpendFreezeRepository['listActive']>[0],
  adapters: { db: { spendFreezes: Pick<ISpendFreezeRepository, 'listActive'> } }
) => adapters.db.spendFreezes.listActive(query);

export const getFreezeHistory = (
  scope: Parameters<ISpendFreezeRepository['listHistory']>[0],
  limit: number,
  cursor: string | undefined,
  adapters: { db: { spendFreezes: Pick<ISpendFreezeRepository, 'listHistory'> } }
) => adapters.db.spendFreezes.listHistory(scope, limit, cursor);
