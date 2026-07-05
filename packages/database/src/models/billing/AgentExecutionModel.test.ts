import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import AgentExecutionModel, { agentExecutionRepository, type AgentExecutionStatus } from './AgentExecutionModel';
import { setupMongoTest } from '../../__test__/utils';

const ACTIVE_STATUSES: AgentExecutionStatus[] = [
  'pending',
  'running',
  'continuing',
  'awaiting_permission',
  'awaiting_subagent',
  'awaiting_dag_children',
  'paused',
];

const TERMINAL_STATUSES: AgentExecutionStatus[] = ['completed', 'failed', 'aborted'];

function makeBaseExecution(overrides: Partial<Parameters<typeof agentExecutionRepository.create>[0]> = {}) {
  return {
    userId: new mongoose.Types.ObjectId().toString(),
    sessionId: new mongoose.Types.ObjectId().toString(),
    questId: new mongoose.Types.ObjectId().toString(),
    query: 'test query',
    model: 'test-model',
    status: 'pending' as AgentExecutionStatus,
    approvedTools: [],
    deniedTools: [],
    iterationBilling: [],
    totalCreditsUsed: 0,
    lambdaInvocationCount: 1,
    childExecutionIds: [],
    ...overrides,
  };
}

describe('AgentExecutionRepository', () => {
  setupMongoTest();

  describe('countActiveByUserId', () => {
    it('counts top-level executions in any active status', async () => {
      const userId = new mongoose.Types.ObjectId().toString();

      for (const status of ACTIVE_STATUSES) {
        await agentExecutionRepository.create(makeBaseExecution({ userId, status }));
      }

      const count = await agentExecutionRepository.countActiveByUserId(userId);
      expect(count).toBe(ACTIVE_STATUSES.length);
    });

    it('excludes terminal statuses from the count', async () => {
      const userId = new mongoose.Types.ObjectId().toString();

      await agentExecutionRepository.create(makeBaseExecution({ userId, status: 'running' }));
      for (const status of TERMINAL_STATUSES) {
        await agentExecutionRepository.create(makeBaseExecution({ userId, status }));
      }

      const count = await agentExecutionRepository.countActiveByUserId(userId);
      expect(count).toBe(1);
    });

    it('excludes subagent executions (those with parentExecutionId)', async () => {
      const userId = new mongoose.Types.ObjectId().toString();

      const parent = await agentExecutionRepository.create(makeBaseExecution({ userId, status: 'running' }));
      // Create three subagents - they should NOT count against the cap
      await agentExecutionRepository.create(
        makeBaseExecution({ userId, status: 'running', parentExecutionId: parent.id })
      );
      await agentExecutionRepository.create(
        makeBaseExecution({ userId, status: 'running', parentExecutionId: parent.id })
      );
      await agentExecutionRepository.create(
        makeBaseExecution({ userId, status: 'running', parentExecutionId: parent.id })
      );

      const count = await agentExecutionRepository.countActiveByUserId(userId);
      expect(count).toBe(1);
    });

    it('only counts the requested user', async () => {
      const userA = new mongoose.Types.ObjectId().toString();
      const userB = new mongoose.Types.ObjectId().toString();

      await agentExecutionRepository.create(makeBaseExecution({ userId: userA, status: 'running' }));
      await agentExecutionRepository.create(makeBaseExecution({ userId: userB, status: 'running' }));
      await agentExecutionRepository.create(makeBaseExecution({ userId: userB, status: 'running' }));

      expect(await agentExecutionRepository.countActiveByUserId(userA)).toBe(1);
      expect(await agentExecutionRepository.countActiveByUserId(userB)).toBe(2);
    });

    it('returns 0 when no executions exist', async () => {
      const userId = new mongoose.Types.ObjectId().toString();
      expect(await agentExecutionRepository.countActiveByUserId(userId)).toBe(0);
    });
  });

  describe('incrementCreditsUsed', () => {
    it('adds credits to totalCreditsUsed atomically', async () => {
      const exec = await agentExecutionRepository.create(makeBaseExecution({ totalCreditsUsed: 10 }));

      await agentExecutionRepository.incrementCreditsUsed(exec.id, 5);
      let updated = await agentExecutionRepository.findById(exec.id);
      expect(updated?.totalCreditsUsed).toBe(15);

      await agentExecutionRepository.incrementCreditsUsed(exec.id, 7);
      updated = await agentExecutionRepository.findById(exec.id);
      expect(updated?.totalCreditsUsed).toBe(22);
    });

    it('is a no-op for zero or negative amounts', async () => {
      const exec = await agentExecutionRepository.create(makeBaseExecution({ totalCreditsUsed: 100 }));

      await agentExecutionRepository.incrementCreditsUsed(exec.id, 0);
      await agentExecutionRepository.incrementCreditsUsed(exec.id, -50);

      const updated = await agentExecutionRepository.findById(exec.id);
      expect(updated?.totalCreditsUsed).toBe(100);
    });
  });

  describe('addChildExecution', () => {
    it('links a child id to the parent without duplicating', async () => {
      const parent = await agentExecutionRepository.create(makeBaseExecution());
      const childId = new mongoose.Types.ObjectId().toString();

      await agentExecutionRepository.addChildExecution(parent.id, childId);
      await agentExecutionRepository.addChildExecution(parent.id, childId);

      const updated = await agentExecutionRepository.findById(parent.id);
      expect(updated?.childExecutionIds).toHaveLength(1);
      expect(updated?.childExecutionIds.map(String)).toContain(childId);
    });
  });

  describe('countActiveByUserId — background children', () => {
    it('counts background children as top-level for the cap', async () => {
      const userId = new mongoose.Types.ObjectId().toString();

      // Parent + 2 background children -> 3 total. A 4th top-level should be at the cap.
      const parent = await agentExecutionRepository.create(makeBaseExecution({ userId, status: 'running' }));
      await agentExecutionRepository.create(
        makeBaseExecution({
          userId,
          status: 'running',
          isBackgroundExecution: true,
          spawnedByExecutionId: parent.id,
        })
      );
      await agentExecutionRepository.create(
        makeBaseExecution({
          userId,
          status: 'running',
          isBackgroundExecution: true,
          spawnedByExecutionId: parent.id,
        })
      );

      // A sync subagent (has parentExecutionId, no isBackgroundExecution) should NOT count.
      await agentExecutionRepository.create(
        makeBaseExecution({ userId, status: 'running', parentExecutionId: parent.id })
      );

      const count = await agentExecutionRepository.countActiveByUserId(userId);
      expect(count).toBe(3);
    });

    it('counts awaiting_subagent as active', async () => {
      const userId = new mongoose.Types.ObjectId().toString();
      await agentExecutionRepository.create(makeBaseExecution({ userId, status: 'awaiting_subagent' }));
      expect(await agentExecutionRepository.countActiveByUserId(userId)).toBe(1);
    });
  });

  describe('findBackgroundChildrenOf', () => {
    it('returns only active background children of a parent', async () => {
      const userId = new mongoose.Types.ObjectId().toString();
      const parent = await agentExecutionRepository.create(makeBaseExecution({ userId, status: 'running' }));

      const activeBg = await agentExecutionRepository.create(
        makeBaseExecution({
          userId,
          status: 'running',
          isBackgroundExecution: true,
          spawnedByExecutionId: parent.id,
        })
      );
      // Completed background - should be excluded.
      await agentExecutionRepository.create(
        makeBaseExecution({
          userId,
          status: 'completed',
          isBackgroundExecution: true,
          spawnedByExecutionId: parent.id,
        })
      );
      // Sync child (different lineage field) - should be excluded.
      await agentExecutionRepository.create(
        makeBaseExecution({
          userId,
          status: 'running',
          parentExecutionId: parent.id,
        })
      );

      const results = await agentExecutionRepository.findBackgroundChildrenOf(parent.id);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(activeBg.id);
    });
  });

  describe('updateInflightSteps', () => {
    it('writes steps to checkpoint.steps without touching other checkpoint fields', async () => {
      const exec = await agentExecutionRepository.create(makeBaseExecution({ status: 'running' }));
      // Seed a checkpoint with messages + token totals - fields the in-flight
      // writer must NOT touch (boundary `updateCheckpoint` owns those).
      await agentExecutionRepository.updateCheckpoint(exec.id, {
        iteration: 0,
        steps: [],
        messages: [{ role: 'user', content: 'seed' }],
        totalInputTokens: 100,
        totalOutputTokens: 50,
        totalCacheReadTokens: 0,
        totalCacheWriteTokens: 0,
        totalTokens: 150,
        totalCredits: 5,
        toolCallCount: 0,
        confidenceLog: [],
        iterationConfidences: [],
        initialMessageCount: 1,
      });

      const inflightSteps = [
        { type: 'thought', content: 'thinking…', metadata: { timestamp: 1, iteration: 0 } },
        {
          type: 'action',
          content: 'Using tool: delegate_to_agent',
          metadata: { toolName: 'delegate_to_agent', iteration: 0 },
        },
      ];
      await agentExecutionRepository.updateInflightSteps(exec.id, inflightSteps);

      const updated = await agentExecutionRepository.findById(exec.id);
      const checkpoint = updated?.checkpoint as Record<string, unknown> | undefined;
      expect(checkpoint).toBeDefined();
      expect(checkpoint?.steps).toEqual(inflightSteps);
      // Sibling fields untouched.
      expect(checkpoint?.messages).toEqual([{ role: 'user', content: 'seed' }]);
      expect(checkpoint?.totalInputTokens).toBe(100);
      expect(checkpoint?.totalOutputTokens).toBe(50);
      expect(checkpoint?.totalCredits).toBe(5);
    });

    it('creates checkpoint.steps when no checkpoint exists yet', async () => {
      // First-iteration emit: doc has no `checkpoint` field at all because
      // the boundary `updateCheckpoint` hasn't fired yet. `$set` on a dot-
      // path must auto-create the parent for the in-flight write to land.
      const exec = await agentExecutionRepository.create(makeBaseExecution({ status: 'running' }));
      expect(exec.checkpoint).toBeUndefined();

      const steps = [{ type: 'thought', content: 'first', metadata: { timestamp: 1, iteration: 0 } }];
      await agentExecutionRepository.updateInflightSteps(exec.id, steps);

      const updated = await agentExecutionRepository.findById(exec.id);
      expect((updated?.checkpoint as { steps: unknown[] }).steps).toEqual(steps);
    });

    it('overwrites prior in-flight steps (last write wins)', async () => {
      // Two emits in the same iteration: Thought, then Action. The second
      // call should fully replace the steps array - handleReconnect ships
      // whatever the latest write set, no merge semantics involved.
      const exec = await agentExecutionRepository.create(makeBaseExecution({ status: 'running' }));

      await agentExecutionRepository.updateInflightSteps(exec.id, [
        { type: 'thought', content: 'a', metadata: { iteration: 0 } },
      ]);
      await agentExecutionRepository.updateInflightSteps(exec.id, [
        { type: 'thought', content: 'a', metadata: { iteration: 0 } },
        { type: 'action', content: 'b', metadata: { iteration: 0 } },
      ]);

      const updated = await agentExecutionRepository.findById(exec.id);
      const steps = (updated?.checkpoint as { steps: Array<{ type: string }> }).steps;
      expect(steps).toHaveLength(2);
      expect(steps[0]?.type).toBe('thought');
      expect(steps[1]?.type).toBe('action');
    });
  });

  describe('setWaitingOnChild / clearWaitingOnChild', () => {
    it('atomically sets waitingOnChild + status + checkpoint', async () => {
      const exec = await agentExecutionRepository.create(makeBaseExecution({ status: 'running' }));
      const childExecutionId = new mongoose.Types.ObjectId().toString();
      const dispatchedAt = new Date();

      await agentExecutionRepository.setWaitingOnChild(
        exec.id,
        {
          childExecutionId,
          agentName: 'researcher',
          toolUse: { id: 'toolu_abc', name: 'delegate_to_agent', arguments: '{"task":"x"}' },
          dispatchedAt,
        },
        { iteration: 3, foo: 'bar' }
      );

      const updated = await agentExecutionRepository.findById(exec.id);
      expect(updated?.status).toBe('awaiting_subagent');
      expect(updated?.waitingOnChild?.childExecutionId).toBe(childExecutionId);
      expect(updated?.waitingOnChild?.agentName).toBe('researcher');
      expect(updated?.waitingOnChild?.toolUse.id).toBe('toolu_abc');
      expect((updated?.checkpoint as { iteration: number }).iteration).toBe(3);
    });

    it('clears waitingOnChild and resets status to running', async () => {
      const exec = await agentExecutionRepository.create(makeBaseExecution({ status: 'running' }));

      await agentExecutionRepository.setWaitingOnChild(
        exec.id,
        {
          childExecutionId: new mongoose.Types.ObjectId().toString(),
          agentName: 'researcher',
          toolUse: { id: 'toolu_a', name: 'delegate_to_agent', arguments: '{}' },
          dispatchedAt: new Date(),
        },
        {}
      );

      const cleared = await agentExecutionRepository.clearWaitingOnChild(exec.id);
      expect(cleared).toBe(true);

      const updated = await agentExecutionRepository.findById(exec.id);
      expect(updated?.status).toBe('running');
      expect(updated?.waitingOnChild).toBeUndefined();
    });

    it('returns false and does NOT resurrect an aborted execution', async () => {
      // Race scenario: parent is awaiting_subagent -> user aborts -> continuation
      // Lambda already CAS-claimed to running. `markAborted` overwrites status,
      // but `clearWaitingOnChild` must NOT overwrite back to running.
      const exec = await agentExecutionRepository.create(makeBaseExecution({ status: 'awaiting_subagent' }));
      await agentExecutionRepository.setWaitingOnChild(
        exec.id,
        {
          childExecutionId: new mongoose.Types.ObjectId().toString(),
          agentName: 'researcher',
          toolUse: { id: 'toolu_x', name: 'delegate_to_agent', arguments: '{}' },
          dispatchedAt: new Date(),
        },
        {}
      );

      // Simulate the abort: setAbortFlag + markAborted both fire.
      await agentExecutionRepository.setAbortFlag(exec.id);
      await agentExecutionRepository.markAborted(exec.id);

      const cleared = await agentExecutionRepository.clearWaitingOnChild(exec.id);
      expect(cleared).toBe(false);

      const updated = await agentExecutionRepository.findById(exec.id);
      expect(updated?.status).toBe('aborted'); // preserved, not resurrected
      // waitingOnChild stays set when we skip - caller bails, doesn't resume.
      expect(updated?.waitingOnChild).toBeDefined();
    });
  });

  describe('incrementSubagentHandoffCount', () => {
    it('increments the counter independently of lambdaInvocationCount', async () => {
      const exec = await agentExecutionRepository.create(makeBaseExecution({ lambdaInvocationCount: 2 }));

      expect(await agentExecutionRepository.incrementSubagentHandoffCount(exec.id)).toBe(1);
      expect(await agentExecutionRepository.incrementSubagentHandoffCount(exec.id)).toBe(2);

      const updated = await agentExecutionRepository.findById(exec.id);
      expect(updated?.subagentHandoffCount).toBe(2);
      expect(updated?.lambdaInvocationCount).toBe(2);
    });
  });

  describe('setSubagentConfig', () => {
    it('persists the subagentConfig snapshot on a child doc', async () => {
      const child = await agentExecutionRepository.create(makeBaseExecution());

      await agentExecutionRepository.setSubagentConfig(child.id, {
        agentName: 'analyst',
        thoroughness: 'medium',
        maxIterations: 8,
        variables: { DOMAIN: 'auth' },
      });

      const updated = await agentExecutionRepository.findById(child.id);
      expect(updated?.subagentConfig?.agentName).toBe('analyst');
      expect(updated?.subagentConfig?.thoroughness).toBe('medium');
      expect(updated?.subagentConfig?.maxIterations).toBe(8);
      expect(updated?.subagentConfig?.variables).toEqual({ DOMAIN: 'auth' });
    });
  });

  describe('findByUserIdPaginated', () => {
    it('returns only the requested user, newest first', async () => {
      const userA = new mongoose.Types.ObjectId().toString();
      const userB = new mongoose.Types.ObjectId().toString();

      const olderA = await agentExecutionRepository.create(makeBaseExecution({ userId: userA, query: 'a-old' }));
      // Force a distinct timestamp for stable sort ordering.
      await new Promise(r => setTimeout(r, 10));
      const newerA = await agentExecutionRepository.create(makeBaseExecution({ userId: userA, query: 'a-new' }));
      await agentExecutionRepository.create(makeBaseExecution({ userId: userB, query: 'b' }));

      const { items, nextCursor } = await agentExecutionRepository.findByUserIdPaginated(userA, {}, { limit: 10 });

      expect(nextCursor).toBeNull();
      expect(items.map(i => i.id)).toEqual([newerA.id, olderA.id]);
      expect(items.every(i => i.userId === userA)).toBe(true);
    });

    it('omits synchronous in-process subagents but keeps background children', async () => {
      const userId = new mongoose.Types.ObjectId().toString();
      const parent = await agentExecutionRepository.create(makeBaseExecution({ userId }));
      await agentExecutionRepository.create(
        makeBaseExecution({ userId, parentExecutionId: parent.id, query: 'sync-child' })
      );
      const bgChild = await agentExecutionRepository.create(
        makeBaseExecution({
          userId,
          isBackgroundExecution: true,
          spawnedByExecutionId: parent.id,
          query: 'bg-child',
        })
      );

      const { items } = await agentExecutionRepository.findByUserIdPaginated(userId, {}, { limit: 10 });
      const ids = items.map(i => i.id).sort();
      expect(ids).toEqual([parent.id, bgChild.id].sort());
    });

    it('filters by status, model, and credit range', async () => {
      const userId = new mongoose.Types.ObjectId().toString();
      await agentExecutionRepository.create(
        makeBaseExecution({ userId, status: 'completed', model: 'opus', totalCreditsUsed: 50 })
      );
      await agentExecutionRepository.create(
        makeBaseExecution({ userId, status: 'failed', model: 'opus', totalCreditsUsed: 200 })
      );
      await agentExecutionRepository.create(
        makeBaseExecution({ userId, status: 'completed', model: 'haiku', totalCreditsUsed: 30 })
      );

      const byStatus = await agentExecutionRepository.findByUserIdPaginated(
        userId,
        { statuses: ['completed'] },
        { limit: 10 }
      );
      expect(byStatus.items).toHaveLength(2);

      const byModel = await agentExecutionRepository.findByUserIdPaginated(userId, { models: ['opus'] }, { limit: 10 });
      expect(byModel.items).toHaveLength(2);

      const byCredits = await agentExecutionRepository.findByUserIdPaginated(
        userId,
        { minCredits: 40, maxCredits: 100 },
        { limit: 10 }
      );
      expect(byCredits.items).toHaveLength(1);
      expect(byCredits.items[0].totalCreditsUsed).toBe(50);
    });

    it('paginates with a cursor and reports nextCursor when more results remain', async () => {
      const userId = new mongoose.Types.ObjectId().toString();
      const created: string[] = [];
      for (let i = 0; i < 5; i++) {
        const exec = await agentExecutionRepository.create(makeBaseExecution({ userId, query: `q-${i}` }));
        created.push(exec.id);
        // Distinct timestamps so cursor ordering is deterministic.
        await new Promise(r => setTimeout(r, 5));
      }

      const firstPage = await agentExecutionRepository.findByUserIdPaginated(userId, {}, { limit: 2 });
      expect(firstPage.items).toHaveLength(2);
      expect(firstPage.nextCursor).not.toBeNull();
      // Newest first -> last two created.
      expect(firstPage.items.map(i => i.id)).toEqual([created[4], created[3]]);

      const secondPage = await agentExecutionRepository.findByUserIdPaginated(
        userId,
        {},
        { limit: 2, before: firstPage.nextCursor! }
      );
      expect(secondPage.items.map(i => i.id)).toEqual([created[2], created[1]]);

      const thirdPage = await agentExecutionRepository.findByUserIdPaginated(
        userId,
        {},
        { limit: 2, before: secondPage.nextCursor! }
      );
      expect(thirdPage.items.map(i => i.id)).toEqual([created[0]]);
      expect(thirdPage.nextCursor).toBeNull();
    });

    it('does not drop rows at a same-millisecond page boundary', async () => {
      // Reproduces the row-loss bug a `createdAt`-only `$lt` cursor caused
      // when several executions land at the exact same ms (e.g. a parent
      // batch-spawning background children in one tick).
      const userId = new mongoose.Types.ObjectId().toString();
      const sharedTimestamp = new Date('2026-06-01T12:00:00.000Z');
      const created: string[] = [];
      for (let i = 0; i < 4; i++) {
        const exec = await agentExecutionRepository.create(makeBaseExecution({ userId, query: `q-${i}` }));
        // Mongoose's `timestamps: true` overrides any `createdAt` passed to
        // `create()`, so force-stamp the shared value here.
        await AgentExecutionModel.updateOne(
          { _id: exec.id },
          { $set: { createdAt: sharedTimestamp } },
          { timestamps: false }
        );
        created.push(exec.id);
      }

      // Newest-first order at equal createdAt is by _id desc - ObjectIds
      // generated in sequence are monotonically increasing, so reverse the
      // creation order to get the expected output.
      const expectedOrder = [...created].reverse();

      const firstPage = await agentExecutionRepository.findByUserIdPaginated(userId, {}, { limit: 2 });
      expect(firstPage.items).toHaveLength(2);
      expect(firstPage.items.map(i => i.id)).toEqual(expectedOrder.slice(0, 2));
      expect(firstPage.nextCursor).not.toBeNull();

      const secondPage = await agentExecutionRepository.findByUserIdPaginated(
        userId,
        {},
        { limit: 2, before: firstPage.nextCursor! }
      );
      // Without the _id tiebreaker, these two rows would be silently dropped.
      expect(secondPage.items.map(i => i.id)).toEqual(expectedOrder.slice(2, 4));
      expect(secondPage.nextCursor).toBeNull();
    });

    it('ignores a malformed cursor and returns the newest page', async () => {
      const userId = new mongoose.Types.ObjectId().toString();
      await agentExecutionRepository.create(makeBaseExecution({ userId, query: 'a' }));

      const page = await agentExecutionRepository.findByUserIdPaginated(
        userId,
        {},
        { limit: 10, before: 'not-a-valid-cursor' }
      );
      expect(page.items).toHaveLength(1);
    });

    it('projects summary fields and excludes heavy fields', async () => {
      const userId = new mongoose.Types.ObjectId().toString();
      const created = await agentExecutionRepository.create(
        makeBaseExecution({
          userId,
          status: 'completed',
          totalCreditsUsed: 42,
          // Heavy fields that the projection must exclude.
          iterationBilling: [
            {
              iteration: 1,
              inputTokens: 100,
              outputTokens: 50,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              credits: 42,
              model: 'test-model',
              timestamp: new Date(),
            },
          ],
        })
      );
      // Persist a realistic `result` payload so we can verify the dot-notation
      // projection (`result.totalIterations`) keeps the lightweight counter
      // but drops the heavy answer + steps payload.
      await AgentExecutionModel.updateOne(
        { _id: created.id },
        {
          $set: {
            result: {
              totalIterations: 3,
              answer: 'a very long final answer that must not leak into the list response',
              steps: [
                { type: 'thought', content: 'step-1' },
                { type: 'action', content: 'step-2' },
                { type: 'observation', content: 'step-3' },
              ],
            },
          },
        },
        { timestamps: false }
      );

      const { items } = await agentExecutionRepository.findByUserIdPaginated(userId, {}, { limit: 10 });
      expect(items).toHaveLength(1);
      const item = items[0];
      expect(item.totalCreditsUsed).toBe(42);
      expect(item.status).toBe('completed');
      // The lightweight counter under `result` survives - list views surface it.
      expect(item.totalIterations).toBe(3);
      // Summary shape - must not leak the heavy fields back to the client.
      expect(item).not.toHaveProperty('iterationBilling');
      expect(item).not.toHaveProperty('checkpoint');
      expect(item).not.toHaveProperty('approvedTools');
      // The full `result` object stays server-side: no answer, no step trace.
      const itemRecord = item as unknown as Record<string, unknown>;
      expect(itemRecord.answer).toBeUndefined();
      expect(itemRecord.steps).toBeUndefined();
      const itemResult = itemRecord.result as Record<string, unknown> | undefined;
      if (itemResult) {
        expect(itemResult.answer).toBeUndefined();
        expect(itemResult.steps).toBeUndefined();
      }
    });
  });

  // DAG decomposition (coordinate_task)

  describe('setDagSpec', () => {
    it('persists the full decomposition + toolUseId on the parent', async () => {
      const parent = await agentExecutionRepository.create(makeBaseExecution({ status: 'running' }));

      await agentExecutionRepository.setDagSpec(parent.id, {
        toolUseId: 'tool_use_abc',
        tasks: [
          {
            id: 'explore',
            description: 'Search code',
            agentType: 'explore',
            dependsOn: [],
            onFailure: 'cascade',
          },
          {
            id: 'implement',
            description: 'Write code',
            agentType: 'general-purpose',
            dependsOn: ['explore'],
            onFailure: 'cascade',
          },
        ],
      });

      const updated = await agentExecutionRepository.findById(parent.id);
      expect(updated?.dagSpec?.toolUseId).toBe('tool_use_abc');
      expect(updated?.dagSpec?.tasks).toHaveLength(2);
      expect(updated?.dagSpec?.tasks[1].dependsOn).toEqual(['explore']);
    });
  });

  describe('setWaitingOnDagChildren / clearWaitingOnDagChildren', () => {
    it('transitions parent to awaiting_dag_children and persists pending node ids', async () => {
      const parent = await agentExecutionRepository.create(makeBaseExecution({ status: 'running' }));

      await agentExecutionRepository.setWaitingOnDagChildren(parent.id, {
        pendingNodeIds: ['explore', 'plan'],
        toolUseId: 'tool_use_xyz',
        dispatchedAt: new Date(),
      });

      const updated = await agentExecutionRepository.findById(parent.id);
      expect(updated?.status).toBe('awaiting_dag_children');
      expect(updated?.waitingOnDagChildren?.pendingNodeIds).toEqual(['explore', 'plan']);
      expect(updated?.waitingOnDagChildren?.toolUseId).toBe('tool_use_xyz');
    });

    it('clearWaitingOnDagChildren transitions back to running and unsets the marker', async () => {
      const parent = await agentExecutionRepository.create(makeBaseExecution({ status: 'running' }));
      await agentExecutionRepository.setWaitingOnDagChildren(parent.id, {
        pendingNodeIds: ['n1'],
        toolUseId: 'tu1',
        dispatchedAt: new Date(),
      });

      const cleared = await agentExecutionRepository.clearWaitingOnDagChildren(parent.id);
      expect(cleared).toBe(true);

      const updated = await agentExecutionRepository.findById(parent.id);
      expect(updated?.status).toBe('running');
      expect(updated?.waitingOnDagChildren).toBeUndefined();
    });

    it('clearWaitingOnDagChildren refuses to resurrect an aborted parent', async () => {
      const parent = await agentExecutionRepository.create(makeBaseExecution({ status: 'running' }));
      await agentExecutionRepository.setWaitingOnDagChildren(parent.id, {
        pendingNodeIds: ['n1'],
        toolUseId: 'tu1',
        dispatchedAt: new Date(),
      });
      await agentExecutionRepository.markAborted(parent.id);

      const cleared = await agentExecutionRepository.clearWaitingOnDagChildren(parent.id);
      expect(cleared).toBe(false);

      const updated = await agentExecutionRepository.findById(parent.id);
      expect(updated?.status).toBe('aborted');
    });
  });

  describe('findDagChildrenLean', () => {
    it('returns only DAG children of the parent, lean-projected', async () => {
      const parent = await agentExecutionRepository.create(makeBaseExecution({ status: 'awaiting_dag_children' }));
      // A non-DAG subagent child (no dagNodeId) - should NOT be returned
      await agentExecutionRepository.create(makeBaseExecution({ status: 'running', parentExecutionId: parent.id }));
      // Two DAG children
      const dagChild1 = await agentExecutionRepository.create(
        makeBaseExecution({
          status: 'completed',
          parentExecutionId: parent.id,
          dagNodeId: 'explore',
          blockedBy: [],
          totalCreditsUsed: 10,
        })
      );
      const dagChild2 = await agentExecutionRepository.create(
        makeBaseExecution({
          status: 'pending',
          parentExecutionId: parent.id,
          dagNodeId: 'implement',
          blockedBy: ['explore'],
        })
      );

      const children = await agentExecutionRepository.findDagChildrenLean(parent.id);
      expect(children).toHaveLength(2);
      const byNode = new Map(children.map(c => [c.dagNodeId, c]));
      expect(byNode.get('explore')?.status).toBe('completed');
      expect(byNode.get('explore')?.totalCreditsUsed).toBe(10);
      expect(byNode.get('implement')?.blockedBy).toEqual(['explore']);
      // Sanity: dagChild ids returned
      const ids = new Set(children.map(c => String(c._id)));
      expect(ids.has(dagChild1.id)).toBe(true);
      expect(ids.has(dagChild2.id)).toBe(true);
    });
  });

  describe('cleanupStaleActive excludes DAG waiting parents', () => {
    it('does not auto-abort a parent in awaiting_dag_children', async () => {
      const userId = new mongoose.Types.ObjectId().toString();
      const parent = await agentExecutionRepository.create(
        makeBaseExecution({ userId, status: 'awaiting_dag_children' })
      );
      // Force the doc's updatedAt past the cutoff
      await (agentExecutionRepository as unknown as { model: mongoose.Model<unknown> }).model.updateOne(
        { _id: parent.id },
        { $set: { updatedAt: new Date(Date.now() - 60 * 60 * 1000) } },
        { timestamps: false }
      );

      const swept = await agentExecutionRepository.cleanupStaleActive(userId, 20 * 60 * 1000);
      expect(swept).toBe(0);

      const after = await agentExecutionRepository.findById(parent.id);
      expect(after?.status).toBe('awaiting_dag_children');
    });
  });

  describe('claimExecution covers awaiting_dag_children', () => {
    it('atomically transitions awaiting_dag_children → continuing exactly once', async () => {
      const parent = await agentExecutionRepository.create(makeBaseExecution({ status: 'awaiting_dag_children' }));

      const first = await agentExecutionRepository.claimExecution(parent.id, ['awaiting_dag_children'], 'continuing');
      const second = await agentExecutionRepository.claimExecution(parent.id, ['awaiting_dag_children'], 'continuing');

      expect(first).toBe(true);
      expect(second).toBe(false);

      const updated = await agentExecutionRepository.findById(parent.id);
      expect(updated?.status).toBe('continuing');
    });
  });

  describe('markAbandoned', () => {
    const SWEEPABLE_STATUSES: AgentExecutionStatus[] = ACTIVE_STATUSES.filter(
      s => s !== 'awaiting_subagent' && s !== 'awaiting_dag_children'
    );

    it('flips sweepable executions to failed/abandoned and returns the affected docs', async () => {
      const userId = new mongoose.Types.ObjectId().toString();
      const created = await Promise.all(
        SWEEPABLE_STATUSES.map(status => agentExecutionRepository.create(makeBaseExecution({ userId, status })))
      );
      const ids = created.map(c => c.id);

      const result = await agentExecutionRepository.markAbandoned(ids);

      expect(result).toHaveLength(SWEEPABLE_STATUSES.length);
      expect(new Set(result.map(r => r.id))).toEqual(new Set(ids));
      expect(result.every(r => r.userId === userId)).toBe(true);

      for (const id of ids) {
        const updated = await AgentExecutionModel.findById(id);
        expect(updated?.status).toBe('failed');
        expect(updated?.failureReason).toBe('abandoned');
        expect(updated?.completedAt).toBeInstanceOf(Date);
        expect(updated?.error?.message).toMatch(/abandoned/i);
      }
    });

    it('refuses to clobber an execution that has already reached a terminal state', async () => {
      const userId = new mongoose.Types.ObjectId().toString();
      const completed = await agentExecutionRepository.create(makeBaseExecution({ userId, status: 'completed' }));
      const aborted = await agentExecutionRepository.create(makeBaseExecution({ userId, status: 'aborted' }));

      const result = await agentExecutionRepository.markAbandoned([completed.id, aborted.id]);

      expect(result).toHaveLength(0);
      const completedAfter = await AgentExecutionModel.findById(completed.id);
      const abortedAfter = await AgentExecutionModel.findById(aborted.id);
      expect(completedAfter?.status).toBe('completed');
      expect(abortedAfter?.status).toBe('aborted');
      expect(completedAfter?.failureReason).toBeUndefined();
    });

    it('leaves awaiting_subagent alone — a healthy parent can legitimately idle for hours', async () => {
      const userId = new mongoose.Types.ObjectId().toString();
      const waiting = await agentExecutionRepository.create(makeBaseExecution({ userId, status: 'awaiting_subagent' }));

      const result = await agentExecutionRepository.markAbandoned([waiting.id]);

      expect(result).toHaveLength(0);
      const after = await AgentExecutionModel.findById(waiting.id);
      expect(after?.status).toBe('awaiting_subagent');
    });

    it('returns an empty array for an empty id list without touching the database', async () => {
      const result = await agentExecutionRepository.markAbandoned([]);
      expect(result).toEqual([]);
    });

    it('returns only docs actually flipped — a doc that transitioned out of sweepable mid-call is omitted', async () => {
      // Simulate the TOCTOU window: a sweepable doc exists when the caller
      // builds the id list, but transitions to a terminal status before
      // markAbandoned runs its update. The function must not report that
      // id as "marked" - otherwise a caller emitting a WS `failed` event
      // would contradict the doc's real terminal state.
      const userId = new mongoose.Types.ObjectId().toString();
      const survivor = await agentExecutionRepository.create(
        makeBaseExecution({ userId, status: 'awaiting_permission' })
      );
      const racer = await agentExecutionRepository.create(makeBaseExecution({ userId, status: 'running' }));

      // The "race": pretend `racer` naturally completed between caller's read
      // and our update.
      await AgentExecutionModel.collection.updateOne(
        { _id: new mongoose.Types.ObjectId(racer.id) },
        { $set: { status: 'completed' } }
      );

      const result = await agentExecutionRepository.markAbandoned([survivor.id, racer.id]);

      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe(survivor.id);
      const racerAfter = await AgentExecutionModel.findById(racer.id);
      expect(racerAfter?.status).toBe('completed');
      expect(racerAfter?.failureReason).toBeUndefined();
    });
  });

  describe('cleanupStaleActive (reactive sweep contract)', () => {
    it('writes aborted (NOT failed/abandoned) — IterationStream + agentExecutor branch on this status', async () => {
      // Regression guard: changing this terminal status would shift the
      // chat-bubble UX (`useAgentExecution.ts` patches a different reply for
      // `failed` vs `aborted`) and the subagent-observation text in
      // `agentExecutor.ts`. The operator/cron path (`markAbandoned`) is
      // where the new `failed`/`abandoned` classification belongs.
      const userId = new mongoose.Types.ObjectId().toString();
      const stale = await agentExecutionRepository.create(makeBaseExecution({ userId, status: 'awaiting_permission' }));
      const longAgo = new Date(Date.now() - 60 * 60 * 1000);
      await AgentExecutionModel.collection.updateOne(
        { _id: new mongoose.Types.ObjectId(stale.id) },
        { $set: { updatedAt: longAgo } }
      );

      const count = await agentExecutionRepository.cleanupStaleActive(userId, 30 * 60 * 1000);

      expect(count).toBe(1);
      const after = await AgentExecutionModel.findById(stale.id);
      expect(after?.status).toBe('aborted');
      expect(after?.failureReason).toBeUndefined();
      expect(after?.abortedAt).toBeInstanceOf(Date);
    });
  });

  describe('findStaleActiveIds', () => {
    it('returns only sweepable docs older than the cutoff', async () => {
      const userId = new mongoose.Types.ObjectId().toString();
      const longAgo = new Date(Date.now() - 60 * 60 * 1000);

      const stale = await agentExecutionRepository.create(makeBaseExecution({ userId, status: 'awaiting_permission' }));
      // Backdate updatedAt so it qualifies as stale.
      await AgentExecutionModel.collection.updateOne(
        { _id: new mongoose.Types.ObjectId(stale.id) },
        { $set: { updatedAt: longAgo } }
      );

      // Fresh - should NOT be returned.
      await agentExecutionRepository.create(makeBaseExecution({ userId, status: 'awaiting_permission' }));
      // Excluded status - should NOT be returned even if backdated.
      const subagent = await agentExecutionRepository.create(
        makeBaseExecution({ userId, status: 'awaiting_subagent' })
      );
      await AgentExecutionModel.collection.updateOne(
        { _id: new mongoose.Types.ObjectId(subagent.id) },
        { $set: { updatedAt: longAgo } }
      );

      const cutoff = new Date(Date.now() - 30 * 60 * 1000);
      const ids = await agentExecutionRepository.findStaleActiveIds({ olderThan: cutoff });

      expect(ids).toEqual([stale.id]);
    });
  });

  describe('listStuck', () => {
    it('returns stuck executions ordered oldest-first', async () => {
      const userId = new mongoose.Types.ObjectId().toString();
      const longAgo = new Date(Date.now() - 60 * 60 * 1000);
      const veryLongAgo = new Date(Date.now() - 120 * 60 * 1000);

      const newerStale = await agentExecutionRepository.create(
        makeBaseExecution({ userId, status: 'awaiting_permission', query: 'newer' })
      );
      const olderStale = await agentExecutionRepository.create(
        makeBaseExecution({ userId, status: 'paused', query: 'older' })
      );
      await AgentExecutionModel.collection.updateOne(
        { _id: new mongoose.Types.ObjectId(newerStale.id) },
        { $set: { updatedAt: longAgo } }
      );
      await AgentExecutionModel.collection.updateOne(
        { _id: new mongoose.Types.ObjectId(olderStale.id) },
        { $set: { updatedAt: veryLongAgo } }
      );

      const items = await agentExecutionRepository.listStuck({
        olderThan: new Date(Date.now() - 30 * 60 * 1000),
        limit: 10,
      });

      expect(items.map(i => i.query)).toEqual(['older', 'newer']);
    });
  });

  // Typed timeout signal replaces error.message substring matching.
  // These tests lock the contract end-to-end (write via `markFailed`, read via
  // `findById` and `getPollableStatus`) so a future projection or schema tweak
  // can't silently regress the snapshot/timeout-detection flow.
  describe('markFailed — timedOut flag', () => {
    it('persists timedOut: true when the failure was a deadline timeout', async () => {
      const execution = await agentExecutionRepository.create(makeBaseExecution());

      await agentExecutionRepository.markFailed(execution.id, {
        message: 'Subagent stopped before Lambda deadline',
        timedOut: true,
      });

      const updated = await agentExecutionRepository.findById(execution.id);
      expect(updated?.status).toBe('failed');
      expect(updated?.error?.message).toBe('Subagent stopped before Lambda deadline');
      expect(updated?.error?.timedOut).toBe(true);
    });

    it('persists timedOut: false for a non-timeout failure', async () => {
      const execution = await agentExecutionRepository.create(makeBaseExecution());

      await agentExecutionRepository.markFailed(execution.id, {
        message: 'LLM API returned 500',
        timedOut: false,
      });

      const updated = await agentExecutionRepository.findById(execution.id);
      expect(updated?.error?.timedOut).toBe(false);
    });

    it('leaves timedOut undefined when the caller omits it (legacy-doc semantics)', async () => {
      const execution = await agentExecutionRepository.create(makeBaseExecution());

      await agentExecutionRepository.markFailed(execution.id, {
        message: 'Some generic failure',
      });

      const updated = await agentExecutionRepository.findById(execution.id);
      expect(updated?.error?.message).toBe('Some generic failure');
      expect(updated?.error?.timedOut).toBeUndefined();
    });

    it('surfaces timedOut through getPollableStatus so callers can read the typed signal', async () => {
      const execution = await agentExecutionRepository.create(makeBaseExecution());

      await agentExecutionRepository.markFailed(execution.id, {
        message: 'Subagent stopped before Lambda deadline',
        timedOut: true,
      });

      const pollable = await agentExecutionRepository.getPollableStatus(execution.id);
      expect(pollable?.status).toBe('failed');
      expect(pollable?.error?.timedOut).toBe(true);
    });
  });
});
