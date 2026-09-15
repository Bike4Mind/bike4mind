/**
 * A utility type for making a type's properties optional.
 *
 * Eg.
 *
 * `type MyType = { a: string, b: number }`
 *
 * `Optional<MyType, 'b'>` will result in `{ a: string, b?: number }`
 */
export type Optional<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

export type WithId<T> = T & { id: string };

/**
 * A utility type for making a type's properties partial except for the specified keys.
 *
 * Eg.
 *
 * `type MyType = { a: string, b: number }`
 *
 * `PartialExcept<MyType, 'b'>` will result in `{ a: string, b?: number }`
 */
export type PartialExcept<T, K extends keyof T> = Partial<Omit<T, K>> & Pick<T, K>;
