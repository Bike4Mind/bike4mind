import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { ApiKeyScope, CreditHolderType } from '@bike4mind/common';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer } from '../../../../packages/database/src/__test__/createMongoServer';
import { userApiKeyRepository, UserApiKey } from '@bike4mind/database';
import { userApiKeyService, assertKeySpendWithinCap } from '@bike4mind/services';

/**
 * End-to-end guard for the embed spend-cap chain, driving the REAL service
 * functions through the REAL UserApiKey repository against createMongoServer:
 * create a capped key -> accumulate settled spend -> re-validate -> gate. Every
 * unit layer here mocks its neighbor, so only this test proves the field, the
 * accumulator, and the validation projection actually line up at runtime (a mock
 * can assert behavior the real schema strips). Consumes the built dist, so
 * `pnpm turbo:core:build` must be current.
 */

let mongoServer: MongoMemoryServer;

const adapters = { db: { userApiKeys: userApiKeyRepository } };

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
}, 30000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
}, 30000);
afterEach(async () => {
  await mongoose.connection.dropDatabase();
});

const mintCappedKey = (spendCap?: number) =>
  userApiKeyService.createUserApiKey(
    'owner-1',
    {
      name: 'widget key',
      scopes: [ApiKeyScope.EMBED_CHAT],
      metadata: { createdFrom: 'dashboard' as const },
      agentId: 'agent-1',
      organizationId: 'org-1',
      billingOwnerType: CreditHolderType.Organization,
      ...(spendCap !== undefined && { spendCap }),
    },
    adapters
  );

describe('embed spend cap (end-to-end, real repos + Mongo)', () => {
  it('blocks a key once accumulated spend reaches its cap, through the real validate projection', async () => {
    const minted = await mintCappedKey(100);

    // Under cap: validation surfaces the snapshot and the gate passes.
    await userApiKeyRepository.incrementSpend(minted.id, 60);
    let validation = await userApiKeyService.validateUserApiKeyById(minted.id, adapters);
    expect(validation.isValid).toBe(true);
    expect(validation.spendCap).toBe(100);
    expect(validation.currentSpend).toBe(60);
    expect(() =>
      assertKeySpendWithinCap({ spendCap: validation.spendCap, currentSpend: validation.currentSpend })
    ).not.toThrow();

    // Cross the cap: the same chain now refuses.
    await userApiKeyRepository.incrementSpend(minted.id, 40);
    validation = await userApiKeyService.validateUserApiKeyById(minted.id, adapters);
    expect(validation.currentSpend).toBe(100);
    expect(() =>
      assertKeySpendWithinCap({ spendCap: validation.spendCap, currentSpend: validation.currentSpend })
    ).toThrow(/spend cap/);
  });

  it('an uncapped key never gates, at any accumulated spend', async () => {
    const minted = await mintCappedKey();

    await userApiKeyRepository.incrementSpend(minted.id, 1_000_000);
    const validation = await userApiKeyService.validateUserApiKeyById(minted.id, adapters);
    expect(validation.spendCap).toBeUndefined();
    expect(validation.currentSpend).toBe(1_000_000);
    expect(() =>
      assertKeySpendWithinCap({ spendCap: validation.spendCap, currentSpend: validation.currentSpend })
    ).not.toThrow();
  });

  it('an over-cap key resumes after the cap is raised, cleared, or the meter is reset (top-up levers)', async () => {
    const minted = await mintCappedKey(50);
    await userApiKeyRepository.incrementSpend(minted.id, 50);

    const gateFor = async () => {
      const v = await userApiKeyService.validateUserApiKeyById(minted.id, adapters);
      return () => assertKeySpendWithinCap({ spendCap: v.spendCap, currentSpend: v.currentSpend });
    };
    expect(await gateFor()).toThrow(/spend cap/);

    // Lever 1: raise the cap above the accumulated spend.
    await userApiKeyService.setEmbedKeySpendCap('owner-1', { keyId: minted.id, spendCap: 200 }, adapters);
    expect(await gateFor()).not.toThrow();

    // Lever 2: clear the cap entirely - the field goes absent, not null/0.
    await userApiKeyService.setEmbedKeySpendCap('owner-1', { keyId: minted.id, spendCap: 50 }, adapters);
    expect(await gateFor()).toThrow(/spend cap/);
    await userApiKeyService.setEmbedKeySpendCap('owner-1', { keyId: minted.id, spendCap: null }, adapters);
    const cleared = await userApiKeyService.validateUserApiKeyById(minted.id, adapters);
    expect(cleared.spendCap).toBeUndefined();
    expect(await gateFor()).not.toThrow();

    // Lever 3: keep the cap but zero the meter.
    await userApiKeyService.setEmbedKeySpendCap('owner-1', { keyId: minted.id, spendCap: 50 }, adapters);
    expect(await gateFor()).toThrow(/spend cap/);
    await userApiKeyService.resetEmbedKeySpend('owner-1', { keyId: minted.id }, adapters);
    const reset = await userApiKeyService.validateUserApiKeyById(minted.id, adapters);
    expect(reset.currentSpend).toBe(0);
    expect(await gateFor()).not.toThrow();
  });

  it('the top-up levers refuse a caller who does not own the key', async () => {
    const minted = await mintCappedKey(50);
    await expect(
      userApiKeyService.setEmbedKeySpendCap('someone-else', { keyId: minted.id, spendCap: 200 }, adapters)
    ).rejects.toThrow(/not found/i);
    await expect(userApiKeyService.resetEmbedKeySpend('someone-else', { keyId: minted.id }, adapters)).rejects.toThrow(
      /not found/i
    );
  });

  it('a stored cap of 0 blocks all spend through the real chain (falsy trap)', async () => {
    // Mint rejects 0, but a stored 0 (e.g. set by the cap-update path) must gate.
    const minted = await mintCappedKey(1);
    await UserApiKey.updateOne({ _id: minted.id }, { $set: { spendCap: 0 } });

    const validation = await userApiKeyService.validateUserApiKeyById(minted.id, adapters);
    expect(validation.spendCap).toBe(0);
    expect(() =>
      assertKeySpendWithinCap({ spendCap: validation.spendCap, currentSpend: validation.currentSpend })
    ).toThrow(/spend cap/);
  });
});
