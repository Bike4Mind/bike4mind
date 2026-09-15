// Checks if a value is a valid member of the given enum.
export function isValidEnumValue<T extends Record<string, string>>(value: string, enumObj: T): value is T[keyof T] {
  return (Object.values(enumObj) as Array<T[keyof T]>).includes(value as T[keyof T]);
}
