import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { agentExecutionRepository, type IOptiPlanState } from '@bike4mind/database';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { rehydrateOptiPlanState } from './agentExecutorUtils/optiPlanLedger';
import { createExecutorAgentExtensions, type ExecutorToolMap } from './agentExecutor.agentExtensions';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: MongoMemoryServer;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

const stored: IOptiPlanState = {
  decomposeUsed: true,
  steps: [
    { family: 'family-a', title: 'First step' },
    { family: 'family-b', title: 'Second step' },
  ],
  solved: { 'family-a': 1 },
  results: { 'family-a': 'digest-a' },
};

async function createExecution() {
  return agentExecutionRepository.create({
    userId: new mongoose.Types.ObjectId().toString(),
    sessionId: new mongoose.Types.ObjectId().toString(),
    questId: new mongoose.Types.ObjectId().toString(),
    query: 'two-part brief',
    model: 'test-model',
    status: 'pending',
    approvedTools: [],
    deniedTools: [],
    iterationBilling: [],
    totalCreditsUsed: 0,
    lambdaInvocationCount: 1,
    childExecutionIds: [],
  });
}

describe('stored plan ledger through the extension registry', () => {
  it('loads a persisted ledger and hands it to every guard as the shared run state', async () => {
    const exec = await createExecution();
    await agentExecutionRepository.updateCheckpoint(exec.id, { steps: [] }, stored);

    const loaded = await agentExecutionRepository.findById(exec.id);
    const runState = rehydrateOptiPlanState(loaded?.optiPlanState);
    expect(runState).toEqual(stored);

    const seen: IOptiPlanState[] = [];
    const registry = createExecutorAgentExtensions([
      {
        toolMapGuards: [
          {
            id: 'ledger-probe',
            priority: 1,
            apply: (tools, ctx) => {
              seen.push(ctx.runState);
              return tools;
            },
          },
        ],
      },
    ]);
    const logger = { info: vi.fn(), warn: vi.fn() };
    const tools: ExecutorToolMap = {};

    expect(registry.applyToolMapGuards(tools, { executionId: exec.id, logger, runState })).toEqual({});
    expect(seen).toEqual([runState]);
    expect(seen[0]).toBe(runState);
  });

  it('starts an empty ledger for an execution that never stored one', async () => {
    const exec = await createExecution();
    const loaded = await agentExecutionRepository.findById(exec.id);

    expect(loaded?.optiPlanState).toBeUndefined();
    expect(rehydrateOptiPlanState(loaded?.optiPlanState)).toEqual({
      decomposeUsed: false,
      steps: [],
      solved: {},
      results: {},
    });
  });
});
