import type { GrantPackageRow } from '@client/app/utils/grantPackageAPICalls';

export type CapState = 'total' | 'daily' | null;

/**
 * Which cap would refuse the next redemption, using the same comparisons as reserveRedemption in
 * packages/database GrantPackageModel. Total wins when both are hit since it outlasts the day; 0 is a real cap.
 */
export const capState = (
  row: Pick<GrantPackageRow, 'totalCap' | 'dailyCap' | 'redeemedTotal' | 'redeemedToday'>
): CapState => {
  if (row.totalCap !== null && row.redeemedTotal >= row.totalCap) return 'total';
  if (row.dailyCap !== null && row.redeemedToday >= row.dailyCap) return 'daily';
  return null;
};
