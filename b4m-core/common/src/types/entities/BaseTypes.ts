export interface IBaseRepository<T> {
  find: (filter: Record<string, unknown>) => Promise<T[]>;
  findOne: (filter: Record<string, unknown>) => Promise<T | null>;
  create: (data: Omit<T, 'id' | 'updatedAt' | 'createdAt'>) => Promise<T>;
  findById: (id: string) => Promise<T | null>;
  update: (data: Partial<T>, options?: Record<string, unknown>) => Promise<T | null>;
  /**
   * Opt-in optimistic-concurrency variant of `update`; see BaseRepository.updateGuarded. Optional so
   * adding it stays additive: an external implementer of this interface is not broken by the new member.
   */
  updateGuarded?: (data: Partial<T>, options?: Record<string, unknown>) => Promise<T | null>;
  updateMany: (filter: Record<string, unknown>, data: Partial<T>) => Promise<unknown>;
  delete: (id: string) => Promise<unknown>;
  count: (filter: Record<string, unknown>) => Promise<number>;
}
