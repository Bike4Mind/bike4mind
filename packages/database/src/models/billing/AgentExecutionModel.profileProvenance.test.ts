import { afterEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import AgentExecutionModel, { agentExecutionRepository } from './AgentExecutionModel';
import { setupMongoTest } from '../../__test__/utils';

describe('agent execution profile provenance', () => {
  setupMongoTest();
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function createExecution() {
    return agentExecutionRepository.create({
      userId: new mongoose.Types.ObjectId().toString(),
      sessionId: new mongoose.Types.ObjectId().toString(),
      questId: new mongoose.Types.ObjectId().toString(),
      query: 'test query',
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

  it('leaves legacy provenance unknown rather than defaulting to unpinned', async () => {
    const execution = await createExecution();
    await agentExecutionRepository.persistProfileDeniedTools(execution.id, ['coordinate_task']);

    const loaded = await agentExecutionRepository.findById(execution.id);

    expect(loaded?.profileIsPinned).toBeUndefined();
    expect(loaded?.profileDeniedTools).toEqual(['coordinate_task']);
  });

  it.each([true, false])('persists profileIsPinned=%s together with its denials', async profileIsPinned => {
    const execution = await createExecution();
    const update = vi.spyOn(AgentExecutionModel, 'updateOne');
    await agentExecutionRepository.persistProfileDeniedTools(execution.id, ['coordinate_task'], profileIsPinned);

    const loaded = await agentExecutionRepository.findById(execution.id);

    expect(loaded?.profileIsPinned).toBe(profileIsPinned);
    expect(loaded?.profileDeniedTools).toEqual(['coordinate_task']);
    expect(update).toHaveBeenCalledExactlyOnceWith(
      { _id: execution.id },
      { $set: { profileDeniedTools: ['coordinate_task'], profileIsPinned } }
    );
  });
});
