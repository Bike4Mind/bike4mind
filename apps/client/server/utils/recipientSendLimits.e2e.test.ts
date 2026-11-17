import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Cache, cacheRepository, mongoose } from '@bike4mind/database';
import { deliveryMailbox } from '@bike4mind/server-utils/utils/deliveryMailbox';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';
import { otcEmailKey } from './otcLimits';
import { RECIPIENT_SEND_WINDOWS, reserveRecipientSendBudget } from './recipientSendLimits';

vi.mock('@bike4mind/server-utils/utils/config', () => ({ isE2EEnabled: () => false }));
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let server: Awaited<ReturnType<typeof createMongoReplSet>>;
const keyOf = (address: string, window: string) =>
  `recipient-send-limit:${window}:${otcEmailKey(deliveryMailbox(address))}`;
const countOf = async (address: string, window: string) => {
  const entry = await Cache.findOne({ key: keyOf(address, window) }).lean();
  return entry ? z.object({ count: z.number() }).parse(entry.result).count : 0;
};
const deferred = () => {
  let release: (() => void) | undefined;
  const promise = new Promise<void>(resolve => {
    release = resolve;
  });
  return {
    promise,
    resolve: () => {
      if (!release) throw new Error('Deferred not initialized');
      release();
    },
  };
};

beforeAll(async () => {
  server = await createMongoReplSet();
  await mongoose.connect(server.getUri(), { autoIndex: false });
  await Cache.syncIndexes();
  await settleAutoIndexBuilds(mongoose);
});
beforeEach(async () => {
  await Cache.deleteMany({});
});
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

describe('atomic recipient admission', () => {
  it.each(RECIPIENT_SEND_WINDOWS)(
    'does not spend earlier windows when concurrent $name admission is refused',
    async window => {
      const [fresh, busy] = ['fresh@example.test', 'busy@example.test'].sort((left, right) =>
        otcEmailKey(deliveryMailbox(left)).localeCompare(otcEmailKey(deliveryMailbox(right)))
      );
      const targetKey = keyOf(busy, window.name);
      const original = cacheRepository.tryAddWithinLimitFixedWindow.bind(cacheRepository);
      await original(targetKey, window.limit - 1, window.limit, window.windowMs);
      const entered = deferred();
      const resume = deferred();
      const accepted: string[] = [];
      let paused = false;
      vi.spyOn(cacheRepository, 'tryAddWithinLimitFixedWindow').mockImplementation(async (...args) => {
        const [key, amount] = args;
        if (!paused && key === targetKey && amount === 1) {
          paused = true;
          entered.resolve();
          await resume.promise;
        }
        const result = await original(...args);
        if (amount === 1 && result.success) accepted.push(key);
        return result;
      });
      const admission = reserveRecipientSendBudget([fresh, busy]);
      try {
        await entered.promise;
        expect(accepted).toContain(keyOf(fresh, 'hourly'));
        expect(accepted).toContain(keyOf(fresh, 'daily'));
        expect((await original(targetKey, 1, window.limit, window.windowMs)).success).toBe(true);
      } finally {
        resume.resolve();
      }
      expect(await admission).toEqual({ retryAfter: expect.any(Number) });
      expect(await countOf(fresh, 'hourly')).toBe(0);
      expect(await countOf(fresh, 'daily')).toBe(0);
      expect(await countOf(busy, window.name)).toBe(window.limit);
      if (window.name === 'daily') expect(await countOf(busy, 'hourly')).toBe(0);
    }
  );

  it('serializes simultaneous claims on empty windows without abort-loop failures or overspend', async () => {
    const address = 'concurrent@example.test';
    const outcomes = await Promise.all(Array.from({ length: 12 }, () => reserveRecipientSendBudget([address])));
    expect(outcomes.filter(outcome => outcome === undefined)).toHaveLength(5);
    expect(outcomes.filter(outcome => outcome !== undefined)).toHaveLength(7);
    expect(await countOf(address, 'hourly')).toBe(5);
    expect(await countOf(address, 'daily')).toBe(5);
  });

  it('charges overlapping batches consistently regardless of input order', async () => {
    const addresses = ['first@example.test', 'second@example.test'];
    const outcomes = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        reserveRecipientSendBudget(index % 2 === 0 ? addresses : [...addresses].reverse())
      )
    );
    expect(outcomes.filter(outcome => outcome === undefined)).toHaveLength(5);
    for (const address of addresses) {
      expect(await countOf(address, 'hourly')).toBe(5);
      expect(await countOf(address, 'daily')).toBe(5);
    }
  });

  it('rolls back earlier charges on an unexpected cache write failure', async () => {
    const address = 'failure@example.test';
    const original = cacheRepository.tryAddWithinLimitFixedWindow.bind(cacheRepository);
    vi.spyOn(cacheRepository, 'tryAddWithinLimitFixedWindow').mockImplementation(async (...args) => {
      if (args[0] === keyOf(address, 'daily') && args[1] === 1) throw new Error('cache write failed');
      return original(...args);
    });
    await expect(reserveRecipientSendBudget([address])).rejects.toThrow('cache write failed');
    expect(await countOf(address, 'hourly')).toBe(0);
    expect(await countOf(address, 'daily')).toBe(0);
  });
});
