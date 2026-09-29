/**
 * `update` options: Mongoose passthrough plus the reserved `unset` list (see IBaseRepository.update).
 * Each entry is a top-level field or a dotted path under one, so a typo in the root fails to compile.
 */
export type RepositoryUpdateOptions<T> = {
  unset?: ((keyof T & string) | `${keyof T & string}.${string}`)[];
} & Record<string, unknown>;

/**
 * `update` data: the changed top-level fields, plus leaf paths (`'visual.portraitUrl'`) that `$set` one
 * field inside a sub-document without rewriting its siblings. A path's root must be a real field, so a
 * typo in it fails to compile; the value under a path is not checked.
 */
export type RepositoryPatch<T> = Partial<T> & { [P in `${keyof T & string}.${string}`]?: unknown };

/**
 * `update`'s call shape. Two overloads rather than one `RepositoryPatch<T>` parameter: the leaf-path
 * signature is an index signature, which a whole interface-typed document is not assignable to, so a
 * single signature would break every caller that passes one.
 */
export type RepositoryUpdate<T> = {
  (data: Partial<T>, options?: RepositoryUpdateOptions<T>): Promise<T | null>;
  (data: RepositoryPatch<T>, options?: RepositoryUpdateOptions<T>): Promise<T | null>;
};

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
  update: RepositoryUpdate<T>;
  /**
   * Opt-in optimistic-concurrency variant of `update`; see BaseRepository.updateGuarded. Optional so
   * adding it stays additive: an external implementer of this interface is not broken by the new member.
   * Honours the same reserved `unset` option as `update`.
   */
  updateGuarded?: RepositoryUpdate<T>;
  updateMany: (filter: Record<string, unknown>, data: Partial<T>) => Promise<unknown>;
  delete: (id: string) => Promise<unknown>;
  count: (filter: Record<string, unknown>) => Promise<number>;
}
