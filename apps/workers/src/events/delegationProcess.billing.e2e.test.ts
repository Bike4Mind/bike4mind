import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import { CREDITS_PER_USD_COST, ModelBackend, type ModelInfo } from '@bike4mind/common';
import {
  AdminSettings,
  CreditTransaction,
  DelegatedItemModel,
  Organization,
  UsageEvent,
  User,
  creditTransactionRepository,
  delegatedItemRepository,
} from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import {
  createMongoReplSet,
  MONGO_TEST_TIMEOUT_MS,
  settleAutoIndexBuilds,
} from '../../../../packages/database/src/__test__/createMongoServer';

const external = vi.hoisted(() => ({
  budget: vi.fn(async (_event: unknown) => {}),
  member: vi.fn(async (_event: unknown) => {}),
  publish: vi.fn(async () => {
    throw new Error('Unexpected event publication in billing fixture');
  }),
}));
vi.mock('@workers/utils/eventContext', () => ({ withEventContext: (handler: unknown) => handler }));
vi.mock('@bike4mind/server-utils/utils/eventBus', () => ({
  DelegationEvents: { Process: { schema: { parse: (value: unknown) => value } } },
  EmailEvents: { Send: { publish: external.publish } },
}));
vi.mock('@bike4mind/server-utils/services/operationsModelService', () => ({
  OperationsModelService: {
    getOperationsModel: () => {
      throw new Error('Unexpected real model acquisition');
    },
  },
}));
vi.mock('@bike4mind/server-utils/billing/billedWebTools', () => ({
  billedWebFetch: () => {
    throw new Error('Unexpected web provider call');
  },
}));
vi.mock('@workers/events/sessionOperationalCreditGate', () => ({
  payerCanFundSessionOperation: () => {
    throw new Error('Unexpected default handler entry');
  },
}));
vi.mock('@bike4mind/server-utils/entitlements/activeSubscriptions', () => ({
  activePlanResolver: {
    hasActivePlan: () => {
      throw new Error('Explicit billing toggle must avoid plan lookup');
    },
  },
}));
vi.mock('@bike4mind/server-utils/organizations/evaluateOrgBudget', () => ({ evaluateOrgBudget: external.budget }));
vi.mock('@bike4mind/server-utils/organizations/evaluateMemberCap', () => ({ evaluateMemberCap: external.member }));

// These are deliberately REAL: no recorder, debit, ledger, holder, transaction or database mocks.
import { recordSessionOperationalUsage } from './recordSessionOperationalUsage';
import { processDelegation, type DelegationProcessDeps } from './delegationProcess';
import { handleOrgEvent } from '@bike4mind/server-utils/organizations/orgAlertDispatcher';
import { setOrgEventObserver } from '@bike4mind/services/organizationService/orgEventObserver';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
const modelInfo: ModelInfo = {
  id: 'gpt-4o-mini',
  type: 'text',
  name: 'Fixture model',
  backend: ModelBackend.OpenAI,
  contextWindow: 1_000_000,
  max_tokens: 800,
  // Exactly $1 for one input token, hence an integral charge with no stochastic rounding ambiguity.
  pricing: { 1_000_000: { input: 1, output: 0 } },
};
const charge = CREDITS_PER_USD_COST;
const initial = charge * 5;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
let server: MongoMemoryReplSet;

beforeAll(async () => {
  server = await createMongoReplSet();
  await mongoose.connect(server.getUri(), { autoIndex: false, monitorCommands: true });
  await settleAutoIndexBuilds(mongoose);
  await Promise.all([
    User.createCollection(),
    Organization.createCollection(),
    AdminSettings.createCollection(),
    CreditTransaction.createCollection(),
    UsageEvent.createCollection(),
    DelegatedItemModel.createCollection(),
  ]);
});
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('Unexpected HTTP request in billing fixture');
    })
  );
  external.budget.mockImplementation(async () => {});
  external.member.mockImplementation(async () => {});
  setOrgEventObserver(handleOrgEvent);
  await AdminSettings.collection.insertMany([
    { settingName: 'enforceCredits', settingValue: true },
    { settingName: 'billOperationalUsage', settingValue: true },
  ]);
});
afterEach(async () => {
  setOrgEventObserver(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all([
    User.collection.deleteMany({}),
    Organization.collection.deleteMany({}),
    AdminSettings.collection.deleteMany({}),
    CreditTransaction.collection.deleteMany({}),
    UsageEvent.collection.deleteMany({}),
    DelegatedItemModel.collection.deleteMany({}),
  ]);
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

async function fixture(orgPaid: boolean) {
  const userId = new mongoose.Types.ObjectId();
  const orgId = orgPaid ? new mongoose.Types.ObjectId() : null;
  const now = new Date();
  await User.collection.insertOne({
    _id: userId,
    username: 'delegation-billing@example.invalid',
    email: 'delegation-billing@example.invalid',
    name: 'Billing fixture',
    currentCredits: initial,
    lastCreditsPurchasedAt: now,
    ...(orgId ? { organizationId: orgId.toHexString() } : {}),
  });
  if (orgId)
    await Organization.collection.insertOne({
      _id: orgId,
      name: 'Billing fixture',
      userId: userId.toHexString(),
      currentCredits: initial,
      users: [{ userId: userId.toHexString(), permissions: ['member'] }],
      userDetails: [
        {
          id: userId.toHexString(),
          usedCredits: 0,
          periodStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
        },
      ],
    });
  const item = await delegatedItemRepository.create({
    userId: userId.toHexString(),
    intent: 'Summarize',
    text: 'Fixture content',
    url: null,
    fileIds: [],
  });
  const input = { delegationId: item._id.toHexString(), userId: userId.toHexString() };
  const recordRealUsage = () =>
    recordSessionOperationalUsage({
      userId: input.userId,
      sessionId: input.delegationId,
      operation: 'delegated_item',
      modelId: modelInfo.id,
      modelInfo,
      completionInfo: { inputTokens: 1, outputTokens: 0 },
      startTime: Date.now(),
      logger,
    });
  const sdk = vi.fn<DelegationProcessDeps['complete']>(async () => ({
    reply: JSON.stringify({ outcome: 'handled', result: 'Done.' }),
    model: modelInfo.id,
    recordUsage: recordRealUsage,
  }));
  const deps: DelegationProcessDeps = {
    now: () => new Date(),
    items: delegatedItemRepository,
    canRun: async () => 'ok',
    fetchPage: async () => {
      throw new Error('No fixture URL');
    },
    findFile: async () => null,
    fileText: async () => '',
    complete: sdk,
    logger,
  };
  const balance = async () =>
    orgId
      ? (await Organization.collection.findOne({ _id: orgId }))?.currentCredits
      : (await User.collection.findOne({ _id: userId }))?.currentCredits;
  const memberUsed = async () =>
    orgId
      ? (await Organization.collection.findOne({ _id: orgId }))?.userDetails?.find(detail => detail.id === input.userId)
          ?.usedCredits
      : 0;
  return { input, deps, sdk, recordRealUsage, userId, orgId, balance, memberUsed };
}

type Trace = {
  name: string;
  collection: string;
  session: string;
  transaction: string;
  atomic: boolean;
  processingClaim: boolean;
};
function traceBilling() {
  const commands: Trace[] = [];
  const client = mongoose.connection.getClient();
  const collections = new Set(
    [User, Organization, CreditTransaction, UsageEvent, DelegatedItemModel].map(
      model => model.collection.collectionName
    )
  );
  const onCommand = (event: mongoose.mongo.CommandStartedEvent) => {
    const raw: unknown = event.command;
    if (raw === null || typeof raw !== 'object') return;
    const command = raw as Record<string, unknown>;
    const collection = command[event.commandName];
    if (typeof collection !== 'string' || !collections.has(collection)) return;
    if (!['find', 'findAndModify', 'update', 'insert'].includes(event.commandName)) return;
    // The initial delegation lookup is intentionally outside the finalization transaction.
    if (collection === DelegatedItemModel.collection.collectionName && event.commandName === 'find') return;
    const processingClaim =
      collection === DelegatedItemModel.collection.collectionName &&
      Array.isArray(command.updates) &&
      command.updates.some((value: unknown) => {
        if (value === null || typeof value !== 'object') return false;
        const update = (value as Record<string, unknown>).u;
        if (update === null || typeof update !== 'object') return false;
        const set = (update as Record<string, unknown>).$set;
        return (
          set !== null && typeof set === 'object' && typeof (set as Record<string, unknown>).claimToken === 'string'
        );
      });
    commands.push({
      name: event.commandName,
      collection,
      session: String(JSON.stringify(command.lsid)),
      transaction: String(command.txnNumber),
      atomic: command.autocommit === false,
      processingClaim,
    });
  };
  client.on('commandStarted', onCommand);
  return { commands, stop: () => client.off('commandStarted', onCommand) };
}

for (const orgPaid of [false, true])
  describe(orgPaid ? 'real org-paid delegation accounting' : 'real user-paid delegation accounting', () => {
    it('joins actual holder/debit/member/ledger/usage operations to the owned terminal transaction', async () => {
      const f = await fixture(orgPaid);
      const trace = traceBilling();
      try {
        await processDelegation(f.deps, f.input);
      } finally {
        trace.stop();
      }
      expect(await f.balance()).toBe(initial - charge);
      expect(await User.collection.findOne({ _id: f.userId })).toMatchObject({
        currentCredits: orgPaid ? initial : initial - charge,
      });
      expect(await CreditTransaction.countDocuments({ sessionId: f.input.delegationId })).toBe(1);
      expect(await UsageEvent.countDocuments({ sessionId: f.input.delegationId, creditsCharged: charge })).toBe(1);
      expect((await delegatedItemRepository.findById(f.input.delegationId))?.status).toBe('handled');
      if (orgPaid) expect(await f.memberUsed()).toBe(charge);
      // Exclude only the identified initial acquisition; an escaped terminal write must FAIL this assertion.
      const finalization = trace.commands.filter(command => !command.processingClaim);
      expect(finalization.length).toBeGreaterThan(3);
      expect(finalization.every(command => command.atomic)).toBe(true);
      expect(new Set(finalization.map(command => `${command.session}/${command.transaction}`)).size).toBe(1);
      for (const model of [
        User,
        CreditTransaction,
        UsageEvent,
        DelegatedItemModel,
        ...(orgPaid ? [Organization] : []),
      ]) {
        expect(finalization.some(command => command.collection === model.collection.collectionName)).toBe(true);
      }
      expect(f.sdk).toHaveBeenCalledTimes(1);
      expect(external.publish).not.toHaveBeenCalled();
    });

    it('rolls real balance/ledger/usage back on an outer post-recorder failure, then finalizes buffered output once', async () => {
      const f = await fixture(orgPaid);
      let calls = 0;
      f.sdk.mockResolvedValue({
        reply: JSON.stringify({ outcome: 'handled', result: 'Done.' }),
        model: modelInfo.id,
        recordUsage: async () => {
          calls++;
          if (calls === 2) {
            // The worker's failed terminal CAS is already visible inside this second transaction.
            expect((await delegatedItemRepository.findById(f.input.delegationId))?.status).toBe('failed');
            const holder = f.orgId ? await Organization.findById(f.orgId) : await User.findById(f.userId);
            expect(holder?.currentCredits).toBe(initial);
            expect(await CreditTransaction.countDocuments({ sessionId: f.input.delegationId })).toBe(0);
            expect(await UsageEvent.countDocuments({ sessionId: f.input.delegationId })).toBe(0);
            if (f.orgId)
              expect(
                (await Organization.findById(f.orgId))?.userDetails?.find(detail => detail.id === f.input.userId)
                  ?.usedCredits
              ).toBe(0);
          }
          await f.recordRealUsage();
          expect(await CreditTransaction.countDocuments({ sessionId: f.input.delegationId })).toBe(1);
          expect(await UsageEvent.countDocuments({ sessionId: f.input.delegationId })).toBe(1);
          if (calls === 1) throw new Error('outer failure after real recorder and before commit');
        },
      });
      await processDelegation(f.deps, f.input);
      expect(calls).toBe(2);
      expect(f.sdk).toHaveBeenCalledTimes(1);
      expect(await f.balance()).toBe(initial - charge);
      expect(await CreditTransaction.countDocuments({ sessionId: f.input.delegationId })).toBe(1);
      expect(await UsageEvent.countDocuments({ sessionId: f.input.delegationId })).toBe(1);
      expect((await delegatedItemRepository.findById(f.input.delegationId))?.status).toBe('failed');
      if (orgPaid) expect(await f.memberUsed()).toBe(charge);
      // Aborted-transaction alerts are dropped; only the fallback's committed events are evaluated.
      expect(external.budget).toHaveBeenCalledTimes(orgPaid ? 1 : 0);
      expect(external.member).toHaveBeenCalledTimes(orgPaid ? 1 : 0);
      expect(external.publish).not.toHaveBeenCalled();
    });

    it('preserves intentional best-effort behavior for an inner ledger failure', async () => {
      const f = await fixture(orgPaid);
      vi.spyOn(creditTransactionRepository, 'createTransaction').mockRejectedValueOnce(
        new Error('ledger rejected before insertion')
      );
      await processDelegation(f.deps, f.input);
      expect(await f.balance()).toBe(initial - charge);
      expect(await CreditTransaction.countDocuments({ sessionId: f.input.delegationId })).toBe(0);
      expect(await UsageEvent.countDocuments({ sessionId: f.input.delegationId, creditsCharged: charge })).toBe(1);
      expect((await delegatedItemRepository.findById(f.input.delegationId))?.status).toBe('handled');
      if (orgPaid) expect(await f.memberUsed()).toBe(charge);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('[OPERATIONAL_LEDGER_WRITE_FAILED]'),
        expect.any(Error),
        expect.anything()
      );
      expect(f.sdk).toHaveBeenCalledTimes(1);
    });
    it('admits no real debit/usage when a late provider finishes after B owns the item', async () => {
      const f = await fixture(orgPaid);
      let logicalNow = new Date();
      f.deps.now = () => logicalNow;
      let resolveSdk!: (value: Awaited<ReturnType<DelegationProcessDeps['complete']>>) => void;
      let providerEntered!: () => void;
      const entered = new Promise<void>(resolve => {
        providerEntered = resolve;
      });
      const delayed = new Promise<Awaited<ReturnType<DelegationProcessDeps['complete']>>>(resolve => {
        resolveSdk = resolve;
      });
      f.sdk.mockImplementationOnce(() => {
        providerEntered();
        return delayed;
      });
      const first = processDelegation(f.deps, f.input);
      await entered;
      logicalNow = new Date(logicalNow.getTime() + 180_001);
      expect(await delegatedItemRepository.claim(f.input.delegationId, logicalNow, 180_000, 'B')).toBe(true);
      resolveSdk({
        reply: JSON.stringify({ outcome: 'handled', result: 'Late.' }),
        model: modelInfo.id,
        recordUsage: f.recordRealUsage,
      });
      await first;
      expect(await f.balance()).toBe(initial);
      expect(await CreditTransaction.countDocuments({ sessionId: f.input.delegationId })).toBe(0);
      expect(await UsageEvent.countDocuments({ sessionId: f.input.delegationId })).toBe(0);
      expect(await delegatedItemRepository.findById(f.input.delegationId)).toMatchObject({
        status: 'pending',
        claimToken: 'B',
      });
      expect(external.budget).not.toHaveBeenCalled();
      expect(external.member).not.toHaveBeenCalled();
    });
  });

describe('committed organization aftermath', () => {
  it('waits for real afterCommit routing outside the transaction without reopening completed ownership', async () => {
    const f = await fixture(true);
    let entered!: () => void;
    let release!: () => void;
    const evaluating = new Promise<void>(resolve => {
      entered = resolve;
    });
    const hold = new Promise<void>(resolve => {
      release = resolve;
    });
    external.budget.mockImplementation(async () => {
      const storage = (
        mongoose as unknown as {
          transactionAsyncLocalStorage?: { getStore(): { session?: mongoose.mongo.ClientSession } | undefined };
        }
      ).transactionAsyncLocalStorage;
      expect(storage?.getStore()?.session?.inTransaction() ?? false).toBe(false);
      expect(await f.balance()).toBe(initial - charge);
      expect((await delegatedItemRepository.findById(f.input.delegationId))?.status).toBe('handled');
      entered();
      await hold;
    });
    const running = processDelegation(f.deps, f.input);
    try {
      await evaluating;
      expect(
        await delegatedItemRepository.claim(f.input.delegationId, new Date(Date.now() + 600_000), 180_000, 'late-B')
      ).toBe(false);
    } finally {
      release();
    }
    await running;
    expect(f.sdk).toHaveBeenCalledTimes(1);
    expect(external.budget).toHaveBeenCalledTimes(1);
    expect(external.member).toHaveBeenCalledTimes(1);
    expect(external.publish).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalledWith('[Delegation] processing ownership lost', expect.anything());
  });
});
