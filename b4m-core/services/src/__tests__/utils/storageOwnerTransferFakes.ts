import { vi, type Mock } from 'vitest';

type Repo = object | undefined;

/**
 * Neutral stand-ins for the StorageOwnerTransferDb methods (reassignStorageOwner.ts) so a lake
 * membership test double keeps its meaning: no lake resolves, so no storage owner ever changes.
 * Methods the test already supplies win over these defaults.
 */
export function withStorageOwnerFakes<
  T extends { fabFiles?: Repo; dataLakes?: Repo; users?: Repo; organizations?: Repo },
>(db: T) {
  return {
    ...db,
    fabFiles: {
      findById: vi.fn().mockResolvedValue(null),
      setOwnerOrganizationIfUnchanged: vi.fn().mockResolvedValue(true),
      ...db.fabFiles,
    },
    dataLakes: { findByDatalakeTags: vi.fn().mockResolvedValue([]), ...db.dataLakes },
    users: {
      findById: vi.fn().mockResolvedValue(null),
      incrementCurrentStorage: vi.fn().mockResolvedValue(undefined),
      ...db.users,
    },
    organizations: {
      findById: vi.fn().mockResolvedValue(null),
      incrementCurrentStorage: vi.fn().mockResolvedValue(undefined),
      ...db.organizations,
    },
  } as Omit<T, 'fabFiles' | 'dataLakes' | 'users' | 'organizations'> & {
    fabFiles: NeutralFabFiles & NonNullable<T['fabFiles']>;
    dataLakes: NeutralDataLakes & NonNullable<T['dataLakes']>;
    users: NeutralCounters & NonNullable<T['users']>;
    organizations: NeutralCounters & NonNullable<T['organizations']>;
  };
}

type NeutralFabFiles = { findById: Mock; setOwnerOrganizationIfUnchanged: Mock };
type NeutralDataLakes = { findByDatalakeTags: Mock };
type NeutralCounters = { findById: Mock; incrementCurrentStorage: Mock };
