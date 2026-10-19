export type StorageReconciliationRepair = boolean | ((check: { counter: number; truth: number }) => boolean);

export type StorageCounterReconciliation = {
  counter: number;
  truth: number;
  /** counter - truth, in bytes. */
  drift: number;
  repaired: boolean;
  /** The counter moved between being read and the repair, so nothing was written. */
  conflict: boolean;
};

export type StorageCounterPorts = {
  /** Null when the owner does not exist. */
  readCounter: () => Promise<number | null>;
  readTruth: () => Promise<number>;
  setIfUnchanged: (expected: number, next: number) => Promise<boolean>;
};

/**
 * Shared core of the user and organization storage reconciliations. The counter is read before the
 * truth aggregate so a write landing in between makes the compare-and-set fail rather than be lost.
 * Returns null when the owner does not exist.
 */
export const reconcileStorageCounter = async (
  { readCounter, readTruth, setIfUnchanged }: StorageCounterPorts,
  repair: StorageReconciliationRepair
): Promise<StorageCounterReconciliation | null> => {
  const counter = await readCounter();
  if (counter === null) return null;
  const truth = await readTruth();
  const drift = counter - truth;
  const result = { counter, truth, drift, repaired: false, conflict: false };
  if (drift === 0 || !(typeof repair === 'function' ? repair({ counter, truth }) : repair)) return result;

  const repaired = await setIfUnchanged(counter, truth);
  return { ...result, repaired, conflict: !repaired };
};
