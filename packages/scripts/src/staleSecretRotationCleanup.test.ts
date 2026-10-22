import { describe, expect, it, vi } from 'vitest';
import { deactivateStaleSecretRotations } from './staleSecretRotationCleanup';

const coreRotation = { keyName: 'CORE_SECRET' };
const packageARotation = { keyName: 'PACKAGE_A_SECRET' };
const packageBRotation = { keyName: 'PACKAGE_B_SECRET' };
const removedRotation = { keyName: 'REMOVED_SECRET' };

function deployed(...extra: { keyName: string }[]) {
  const names = [coreRotation, removedRotation, ...extra].map(record => record.keyName);
  return (name: string) => names.includes(name);
}

function fixture() {
  return {
    options: {
      isDryRun: false,
      confirmedCompleteInventory: false,
      confirmedNoContributedRotations: false,
      hasContributedRotations: true,
      unregisteredRotations: [] as string[],
      configKeys: new Set([coreRotation.keyName, packageARotation.keyName]),
      coreResourceNames: [coreRotation.keyName, removedRotation.keyName, 'VPC', 'AppEventBus'] as
        readonly string[] | null,
      isDeployedOnStage: deployed(),
    },
    repository: {
      findActive: vi.fn(async () => [coreRotation, packageARotation, packageBRotation, removedRotation]),
      deactivate: vi.fn(async (records: { keyName: string }[]) => ({ modifiedCount: records.length })),
    },
  };
}

describe('deactivateStaleSecretRotations', () => {
  it('requires confirmation even when a partial tree has registered contributions', async () => {
    const { options, repository } = fixture();

    await expect(deactivateStaleSecretRotations(options, repository)).rejects.toThrow(
      '--confirm-complete-rotation-inventory'
    );

    expect(repository.findActive).not.toHaveBeenCalled();
    expect(repository.deactivate).not.toHaveBeenCalled();
  });

  it('previews records absent from a partial inventory without confirmation or writes', async () => {
    const { options, repository } = fixture();

    const result = await deactivateStaleSecretRotations({ ...options, isDryRun: true }, repository);

    expect(result).toEqual({ staleRecords: [packageBRotation, removedRotation], modifiedCount: 0 });
    expect(repository.findActive).toHaveBeenCalledOnce();
    expect(repository.deactivate).not.toHaveBeenCalled();
  });

  it('preserves both deployed packages once the operator confirms the complete inventory', async () => {
    const { options, repository } = fixture();
    const result = await deactivateStaleSecretRotations(
      {
        ...options,
        confirmedCompleteInventory: true,
        configKeys: new Set([coreRotation.keyName, packageARotation.keyName, packageBRotation.keyName]),
      },
      repository
    );

    expect(result).toEqual({ staleRecords: [removedRotation], modifiedCount: 1 });
    expect(repository.deactivate).toHaveBeenCalledExactlyOnceWith([removedRotation]);
  });

  it('refuses an empty contributed inventory without explicit confirmation', async () => {
    const { options, repository } = fixture();

    await expect(
      deactivateStaleSecretRotations({ ...options, hasContributedRotations: false }, repository)
    ).rejects.toThrow('Refusing to deactivate');

    expect(repository.deactivate).not.toHaveBeenCalled();
  });

  it('accepts the explicit no-contributions confirmation for a core-only stage', async () => {
    const { options, repository } = fixture();
    repository.findActive.mockResolvedValue([coreRotation, removedRotation]);

    const result = await deactivateStaleSecretRotations(
      {
        ...options,
        hasContributedRotations: false,
        confirmedNoContributedRotations: true,
        configKeys: new Set([coreRotation.keyName]),
      },
      repository
    );

    expect(result).toEqual({ staleRecords: [removedRotation], modifiedCount: 1 });
    expect(repository.deactivate).toHaveBeenCalledExactlyOnceWith([removedRotation]);
  });

  it.each([false, true])('rejects a contradictory no-contributions flag with dry-run=%s', async isDryRun => {
    const { options, repository } = fixture();

    await expect(
      deactivateStaleSecretRotations(
        { ...options, isDryRun, confirmedNoContributedRotations: true, confirmedCompleteInventory: true },
        repository
      )
    ).rejects.toThrow('contradicts the declared rotations');

    expect(repository.deactivate).not.toHaveBeenCalled();
  });

  it.each([false, true])('failed registration prevents writes even with no-contributions=%s', async confirmedNone => {
    const { options, repository } = fixture();

    await expect(
      deactivateStaleSecretRotations(
        {
          ...options,
          hasContributedRotations: !confirmedNone,
          confirmedNoContributedRotations: confirmedNone,
          confirmedCompleteInventory: true,
          unregisteredRotations: [packageBRotation.keyName],
        },
        repository
      )
    ).rejects.toThrow('failed to register (PACKAGE_B_SECRET)');

    expect(repository.findActive).not.toHaveBeenCalled();
    expect(repository.deactivate).not.toHaveBeenCalled();
  });

  it('does not write when every active rotation is still configured', async () => {
    const { options, repository } = fixture();
    repository.findActive.mockResolvedValue([coreRotation, packageARotation]);

    await expect(
      deactivateStaleSecretRotations({ ...options, confirmedCompleteInventory: true }, repository)
    ).resolves.toEqual({ staleRecords: [], modifiedCount: 0 });

    expect(repository.deactivate).not.toHaveBeenCalled();
  });

  it('propagates failed inventory reads without writing', async () => {
    const { options, repository } = fixture();
    repository.findActive.mockRejectedValue(new Error('database unavailable'));

    await expect(
      deactivateStaleSecretRotations({ ...options, confirmedCompleteInventory: true }, repository)
    ).rejects.toThrow('database unavailable');

    expect(repository.deactivate).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'refuses a confirmed write while the stage still deploys a stale package secret (dry-run=%s)',
    async isDryRun => {
      const { options, repository } = fixture();

      await expect(
        deactivateStaleSecretRotations(
          {
            ...options,
            isDryRun,
            confirmedCompleteInventory: true,
            isDeployedOnStage: deployed(packageBRotation),
          },
          repository
        )
      ).rejects.toThrow('PACKAGE_B_SECRET still deployed on this stage');

      expect(repository.deactivate).not.toHaveBeenCalled();
    }
  );

  it('refuses the no-contributions flag when the stage still deploys a package secret', async () => {
    const { options, repository } = fixture();

    await expect(
      deactivateStaleSecretRotations(
        {
          ...options,
          hasContributedRotations: false,
          confirmedNoContributedRotations: true,
          configKeys: new Set([coreRotation.keyName]),
          isDeployedOnStage: deployed(packageARotation),
        },
        repository
      )
    ).rejects.toThrow('PACKAGE_A_SECRET still deployed on this stage');

    expect(repository.deactivate).not.toHaveBeenCalled();
  });

  it('retires a stale core record even though the stage still deploys that core secret', async () => {
    const { options, repository } = fixture();

    const result = await deactivateStaleSecretRotations(
      {
        ...options,
        confirmedCompleteInventory: true,
        configKeys: new Set([coreRotation.keyName, packageARotation.keyName, packageBRotation.keyName]),
        isDeployedOnStage: deployed(),
      },
      repository
    );

    expect(result).toEqual({ staleRecords: [removedRotation], modifiedCount: 1 });
  });

  it.each([false, true])('refuses when the glue has no core resource names (dry-run=%s)', async isDryRun => {
    const { options, repository } = fixture();

    await expect(
      deactivateStaleSecretRotations(
        { ...options, isDryRun, confirmedCompleteInventory: true, coreResourceNames: null },
        repository
      )
    ).rejects.toThrow('no core resource names');

    expect(repository.findActive).not.toHaveBeenCalled();
  });

  it.each([false, true])('refuses a shell that links only part of the stage (dry-run=%s)', async isDryRun => {
    const { options, repository } = fixture();

    await expect(
      deactivateStaleSecretRotations(
        {
          ...options,
          isDryRun,
          confirmedCompleteInventory: true,
          isDeployedOnStage: name => name === coreRotation.keyName,
        },
        repository
      )
    ).rejects.toThrow('does not link the whole stage (missing REMOVED_SECRET)');

    expect(repository.findActive).not.toHaveBeenCalled();
  });
});
