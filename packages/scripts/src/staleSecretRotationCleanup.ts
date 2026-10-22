type CleanupOptions = {
  isDryRun: boolean;
  confirmedCompleteInventory: boolean;
  confirmedNoContributedRotations: boolean;
  hasContributedRotations: boolean;
  unregisteredRotations: readonly string[];
  configKeys: ReadonlySet<string>;
};

type RotationRecord = { keyName: string };

type CleanupRepository<Rotation extends RotationRecord> = {
  findActive: () => Promise<Rotation[]>;
  deactivate: (records: Rotation[]) => Promise<{ modifiedCount: number }>;
};

export async function deactivateStaleSecretRotations<Rotation extends RotationRecord>(
  options: CleanupOptions,
  repository: CleanupRepository<Rotation>
) {
  if (options.unregisteredRotations.length > 0) {
    throw new Error(
      `Refusing to deactivate: declared rotation(s) failed to register (${options.unregisteredRotations.join(', ')}), ` +
        'so their records would look stale. Fix the declaration and re-run.'
    );
  }
  if (options.confirmedNoContributedRotations && options.hasContributedRotations) {
    throw new Error('Refusing to deactivate: --no-contributed-rotations contradicts the declared rotations.');
  }
  // A nonempty local inventory can still omit packages deployed to this stage.
  if (!options.isDryRun && !options.confirmedCompleteInventory && !options.confirmedNoContributedRotations) {
    throw new Error(
      'Refusing to deactivate: the local rotation inventory may omit packages deployed to this stage. ' +
        'Mount every deployed package and regenerate glue, then pass --confirm-complete-rotation-inventory. ' +
        'For a stage with no contributed rotations, pass --no-contributed-rotations. Use --dry-run to preview.'
    );
  }

  const activeRecords = await repository.findActive();
  const staleRecords = activeRecords.filter(record => !options.configKeys.has(record.keyName));
  if (options.isDryRun || staleRecords.length === 0) {
    return { staleRecords, modifiedCount: 0 };
  }

  const { modifiedCount } = await repository.deactivate(staleRecords);
  return { staleRecords, modifiedCount };
}
