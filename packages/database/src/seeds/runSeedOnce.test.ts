import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer } from '../__test__/createMongoServer';
import { AdminSettings } from '../models/infra/ops/AdminSettingsModel';
import { runSeedOnce } from './runSeedOnce';
import { POOL_SEED_UNMETERED, seedSignupGrantPools } from './seedSignupGrantPools';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
beforeEach(async () => {
  // Raw driver: the model's softDeletePlugin would only flag rows, and an upsert still matches those.
  await AdminSettings.collection.deleteMany({});
  await mongoose.connection.collection('seedmarkers').deleteMany({});
});

const bootSeed = () => runSeedOnce('signupGrantPools', () => seedSignupGrantPools(AdminSettings));
const poolRow = (settingName: string) => AdminSettings.findOne({ settingName }).lean();

describe('runSeedOnce', () => {
  it('does not re-insert a pool row removed after the first boot', async () => {
    expect(await bootSeed()).toBe(true);
    expect((await poolRow('signupGrantTricklePoolDaily'))?.settingValue).toBe(String(POOL_SEED_UNMETERED));

    await AdminSettings.collection.deleteOne({ settingName: 'signupGrantTricklePoolDaily' });
    expect(await bootSeed()).toBe(false);

    expect(await poolRow('signupGrantTricklePoolDaily')).toBeNull();
    expect(await poolRow('signupGrantSignupPoolDaily')).not.toBeNull();
  });

  it('leaves no marker when the seed throws, so the next boot retries', async () => {
    await expect(
      runSeedOnce('signupGrantPools', async () => {
        throw new Error('db down');
      })
    ).rejects.toThrow('db down');

    expect(await bootSeed()).toBe(true);
    expect(await poolRow('signupGrantSignupPoolDaily')).not.toBeNull();
  });
});
