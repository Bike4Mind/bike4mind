/** True when rows[index][key] has a value but both neighbouring rows have none, so a line would draw nothing for it. */
export function isIsolatedPoint<T extends Record<string, unknown>>(rows: readonly T[], index: number, key: string) {
  const has = (i: number) => rows[i]?.[key] != null;
  return has(index) && !has(index - 1) && !has(index + 1);
}
