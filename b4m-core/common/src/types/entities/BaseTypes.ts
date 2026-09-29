export interface IBaseRepository<T> {
  find: (filter: Record<string, unknown>) => Promise<T[]>;
  findOne: (filter: Record<string, unknown>) => Promise<T | null>;
  create: (data: Omit<T, 'id' | 'updatedAt' | 'createdAt'>) => Promise<T>;
  findById: (id: string) => Promise<T | null>;
  /**
   * `options` is an implementation passthrough (Mongoose `findOneAndUpdate` options in db-core)
   * with ONE reserved key: `{ unset: ['field'] }` removes those fields from the stored document.
   *
   * `data` cannot express a removal. A doc read back through `findById` is a plain object, so
   * `doc.field = undefined` leaves the key present with an `undefined` value, which the driver
   * treats as an absence - the stored value survives the write. Clearing a field means naming it
   * here. See BaseModel's UNSET_OPTION for the full rationale and the `$set`/`$unset` split.
   */
  update: (data: Partial<T>, options?: Record<string, unknown>) => Promise<T | null>;
  /**
   * Opt-in optimistic-concurrency variant of `update`; see BaseRepository.updateGuarded. Optional so
   * adding it stays additive: an external implementer of this interface is not broken by the new member.
   * Honours the same reserved `unset` option as `update`.
   */
  updateGuarded?: (data: Partial<T>, options?: Record<string, unknown>) => Promise<T | null>;
  updateMany: (filter: Record<string, unknown>, data: Partial<T>) => Promise<unknown>;
  delete: (id: string) => Promise<unknown>;
  count: (filter: Record<string, unknown>) => Promise<number>;
}
