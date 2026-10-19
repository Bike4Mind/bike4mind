import { IFabFileRepository, IOrganizationRepository } from '@bike4mind/common';
import { reconcileStorageCounter, StorageReconciliationRepair } from '../lib/reconcileStorageCounter';

export interface ReconcileOrganizationStorageAdapters {
  db: {
    organizations: Pick<IOrganizationRepository, 'findCurrentStorageSize' | 'setCurrentStorageIfUnchanged'>;
    fabFiles: Pick<IFabFileRepository, 'sumFileSizeByOrganizationId'>;
  };
}

export interface OrganizationStorageReconciliation {
  organizationId: string;
  counter: number;
  truth: number;
  /** counter - truth, in bytes. */
  drift: number;
  repaired: boolean;
  /** The counter moved between being read and the repair, so nothing was written. */
  conflict: boolean;
}

/**
 * The organization counterpart of userService.reconcileUserStorage: compares the org's storage counter
 * with the bytes of the files it owns and, when `repair` allows it, sets the counter to that truth by
 * compare-and-set. The same caveat applies: callers that repair unattended should only do so for drift
 * that has held still across checks. Returns null when the organization does not exist.
 */
export const reconcileOrganizationStorage = async (
  { organizationId, repair }: { organizationId: string; repair: StorageReconciliationRepair },
  { db }: ReconcileOrganizationStorageAdapters
): Promise<OrganizationStorageReconciliation | null> => {
  const outcome = await reconcileStorageCounter(
    {
      readCounter: () => db.organizations.findCurrentStorageSize(organizationId),
      readTruth: () => db.fabFiles.sumFileSizeByOrganizationId(organizationId),
      setIfUnchanged: (expected, next) => db.organizations.setCurrentStorageIfUnchanged(organizationId, expected, next),
    },
    repair
  );
  return outcome && { organizationId, ...outcome };
};
