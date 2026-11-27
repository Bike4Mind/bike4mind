/** Table lookup that ignores Object.prototype members, for tables keyed by command text, tool names or other outside input. */
export function own<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}
