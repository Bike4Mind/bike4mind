import { describe, it, expect, beforeEach } from 'vitest';
import { setupMongoTest } from '../../../__test__/utils';
import MemoryPrincipalKeyModel, { memoryPrincipalKeyRepository } from '../MemoryPrincipalKeyModel';

describe('MemoryPrincipalKeyRepository', () => {
  setupMongoTest();

  beforeEach(async () => {
    await MemoryPrincipalKeyModel.ensureIndexes();
  });

  it('mints a key on first getOrCreate, then returns the same key (idempotent)', async () => {
    const first = await memoryPrincipalKeyRepository.getOrCreate('user', 'u1', 'u1', 'dek-A');
    const second = await memoryPrincipalKeyRepository.getOrCreate('user', 'u1', 'u1', 'dek-B');
    expect(first).toBe('dek-A');
    expect(second).toBe('dek-A'); // the second candidate is ignored; one key per principal
  });

  it('findDek returns the key, and null once destroyed (crypto-shred)', async () => {
    await memoryPrincipalKeyRepository.getOrCreate('user', 'u1', 'u1', 'dek-A');
    expect(await memoryPrincipalKeyRepository.findDek('user', 'u1')).toBe('dek-A');
    await memoryPrincipalKeyRepository.destroy('user', 'u1');
    expect(await memoryPrincipalKeyRepository.findDek('user', 'u1')).toBeNull();
  });

  it('isolates keys by principal', async () => {
    await memoryPrincipalKeyRepository.getOrCreate('user', 'u1', 'u1', 'dek-1');
    await memoryPrincipalKeyRepository.getOrCreate('user', 'u2', 'u2', 'dek-2');
    expect(await memoryPrincipalKeyRepository.findDek('user', 'u2')).toBe('dek-2');
    await memoryPrincipalKeyRepository.destroy('user', 'u1');
    expect(await memoryPrincipalKeyRepository.findDek('user', 'u2')).toBe('dek-2'); // u2 untouched
  });
});
