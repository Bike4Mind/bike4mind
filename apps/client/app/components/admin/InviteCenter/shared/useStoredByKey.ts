import { useMemo } from 'react';

/** Saved setting rows keyed by setting name. */
export function useStoredByKey(
  rows: ReadonlyArray<{ settingName: string; settingValue: unknown }> | undefined
): ReadonlyMap<string, unknown> {
  return useMemo(() => new Map(rows?.map(row => [row.settingName, row.settingValue] as const)), [rows]);
}
