type CleanupOptions = {
  isDryRun: boolean;
  confirmedCompleteInventory: boolean;
  confirmedNoContributedRotations: boolean;
  hasContributedRotations: boolean;
  unregisteredRotations: readonly string[];
  configKeys: ReadonlySet<string>;
  /** Core resource names from the generated glue; null when it was generated without infra/. */
  coreResourceNames: readonly string[] | null;
  /** Whether the target stage still deploys a resource under this name. */
  isDeployedOnStage: (name: string) => boolean;
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

  if (options.coreResourceNames === null) {
    throw new Error(
      'Refusing to deactivate: the generated glue has no core resource names (codegen ran without infra/), ' +
        'so package-declared secrets cannot be told apart from core ones. Regenerate glue with infra/ present.'
    );
  }

  // `sst shell --target` links only part of the stage, which would make every lookup below
  // read as "not deployed". Core secrets (UPPER_SNAKE names in infra/secrets.ts) are declared
  // unconditionally, so a full shell links them all; a bare word like VPC may not exist.
  const unlinkedCoreSecrets = options.coreResourceNames.filter(
    name => /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(name) && !options.isDeployedOnStage(name)
  );
  if (unlinkedCoreSecrets.length > 0) {
    throw new Error(
      `Refusing to deactivate: this shell does not link the whole stage (missing ${unlinkedCoreSecrets.join(', ')}). ` +
        'Run it under a plain `sst shell --stage <stage>`, without --target.'
    );
  }

  const activeRecords = await repository.findActive();
  const staleRecords = activeRecords.filter(record => !options.configKeys.has(record.keyName));

  // A package secret the stage still deploys means its package is missing from the local tree.
  const coreNames = new Set(options.coreResourceNames);
  const stillDeployed = staleRecords
    .map(record => record.keyName)
    .filter(name => !coreNames.has(name) && options.isDeployedOnStage(name));
  if (stillDeployed.length > 0) {
    throw new Error(
      `Refusing to deactivate: ${stillDeployed.join(', ')} still deployed on this stage as package-declared ` +
        'secret(s), so the local inventory is missing their package. Mount it, regenerate glue, and re-run.'
    );
  }
  if (options.isDryRun || staleRecords.length === 0) {
    return { staleRecords, modifiedCount: 0 };
  }

  const { modifiedCount } = await repository.deactivate(staleRecords);
  return { staleRecords, modifiedCount };
}
