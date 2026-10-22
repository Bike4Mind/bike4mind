// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ROTATION = {
  secret: 'EXAMPLE_API_TOKEN',
  description: 'Example token',
  rotationIntervalDays: 90,
  isAutomatic: false,
  rotationProcess: 'Rotate upstream, then sst secret set',
};

async function load(declared: { secrets: { name: string }[]; rotations: (typeof ROTATION)[] }) {
  vi.doMock('../../premium-generated/infraResources.generated', () => ({
    contributedInfraResources: declared,
    coreSecretNames: ['MONGODB_URI', 'JWT_SECRET'],
  }));
  return import('./constants');
}

describe('secret rotation registry', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.doUnmock('../../premium-generated/infraResources.generated');
    vi.restoreAllMocks();
  });

  it('returns exactly the core config when nothing is declared', async () => {
    const { getSecretRotationConfig, SECRET_ROTATION_CONFIG, getUnregisteredContributedRotations } = await load({
      secrets: [],
      rotations: [],
    });
    expect(getSecretRotationConfig()).toEqual(SECRET_ROTATION_CONFIG);
    expect(getUnregisteredContributedRotations()).toEqual([]);
  });

  it('adds a declared rotation for a declared secret', async () => {
    const { getSecretRotationConfig, SECRET_ROTATION_CONFIG } = await load({
      secrets: [{ name: 'EXAMPLE_API_TOKEN' }],
      rotations: [ROTATION],
    });
    const config = getSecretRotationConfig();
    expect(config.EXAMPLE_API_TOKEN).toEqual({
      description: 'Example token',
      rotationIntervalDays: 90,
      isAutomatic: false,
      rotationProcess: 'Rotate upstream, then sst secret set',
    });
    expect(config.JWT_SECRET).toEqual(SECRET_ROTATION_CONFIG.JWT_SECRET);
  });

  it('registers secrets before rotations, whatever is called first', async () => {
    const { registerContributedSecretRotations, getSecretRotationConfig } = await load({
      secrets: [{ name: 'EXAMPLE_API_TOKEN' }],
      rotations: [],
    });
    expect(registerContributedSecretRotations([ROTATION]).registered).toHaveLength(1);
    expect(getSecretRotationConfig()).toHaveProperty('EXAMPLE_API_TOKEN');
  });

  it('rejects a rotation for a secret nobody registered and reports it as unregistered', async () => {
    const { getSecretRotationConfig, getUnregisteredContributedRotations } = await load({
      secrets: [],
      rotations: [ROTATION],
    });
    expect(getSecretRotationConfig()).not.toHaveProperty('EXAMPLE_API_TOKEN');
    expect(getUnregisteredContributedRotations()).toEqual(['EXAMPLE_API_TOKEN']);
  });

  it('keeps the core entry when a contribution names a core rotation', async () => {
    const { registerContributedSecretRotations, getSecretRotationConfig, SECRET_ROTATION_CONFIG } = await load({
      secrets: [],
      rotations: [],
    });
    const result = registerContributedSecretRotations([{ ...ROTATION, secret: 'JWT_SECRET', rotationIntervalDays: 1 }]);
    expect(result.coreCollisions).toEqual(['JWT_SECRET']);
    expect(getSecretRotationConfig().JWT_SECRET).toEqual(SECRET_ROTATION_CONFIG.JWT_SECRET);
  });

  it('keeps the first of two rotations for the same secret', async () => {
    const { registerContributedSecretRotations, getSecretRotationConfig } = await load({
      secrets: [{ name: 'EXAMPLE_API_TOKEN' }],
      rotations: [ROTATION],
    });
    getSecretRotationConfig();
    const result = registerContributedSecretRotations([{ ...ROTATION, rotationIntervalDays: 7 }]);
    expect(result.duplicates).toEqual(['EXAMPLE_API_TOKEN']);
    expect(getSecretRotationConfig().EXAMPLE_API_TOKEN.rotationIntervalDays).toBe(90);
  });
});
