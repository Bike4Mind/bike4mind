/**
 * Tests for BackgroundAgentManager
 *
 * Tests concurrency control, job lifecycle, and grouped notifications.
 */

import { describe, it, expect, vi } from 'vitest';
import { BackgroundAgentManager } from './BackgroundAgentManager';
import type { SubagentOrchestrator, SpawnAgentOptions, AgentExecutionResult } from './SubagentOrchestrator';

// Mock orchestrator that resolves/rejects based on configuration
function createMockOrchestrator(
  config: {
    resolveWith?: AgentExecutionResult;
    rejectWith?: Error;
    delay?: number;
  } = {}
): SubagentOrchestrator {
  const defaultResult: AgentExecutionResult = {
    agentName: 'test-agent',
    thoroughness: 'medium',
    summary: 'Test result summary',
    parentSessionId: 'test-session',
    resumeId: 'test-resume-id',
    finalAnswer: 'Test answer',
    steps: [],
    completionInfo: {
      totalTokens: 100,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      iterations: 1,
      toolCalls: 0,
      reachedMaxIterations: false,
    },
  };

  return {
    delegateToAgent: vi.fn().mockImplementation(() => {
      return new Promise((resolve, reject) => {
        const doResolve = () => {
          if (config.rejectWith) {
            reject(config.rejectWith);
          } else {
            resolve(config.resolveWith || defaultResult);
          }
        };

        if (config.delay) {
          setTimeout(doResolve, config.delay);
        } else {
          // Use setImmediate to ensure async behavior
          setImmediate(doResolve);
        }
      });
    }),
  } as unknown as SubagentOrchestrator;
}

// Helper to create spawn options
function createSpawnOptions(overrides: Partial<SpawnAgentOptions> = {}): SpawnAgentOptions {
  return {
    task: 'Test task',
    agentName: 'test-agent',
    parentSessionId: 'test-session',
    resumeId: 'test-resume-id',
    ...overrides,
  };
}

// Helper to wait for all pending promises to resolve
function flushPromises(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

// Helper to wait for all jobs to reach terminal state
async function waitForAllJobsTerminal(manager: BackgroundAgentManager, maxWait = 100): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const jobs = manager.listJobs();
    const allTerminal = jobs.every(job => ['completed', 'failed', 'cancelled'].includes(job.status));
    if (allTerminal && jobs.length > 0) {
      return;
    }
    await flushPromises();
  }
}

describe('BackgroundAgentManager', () => {
  describe('Turn ID tracking', () => {
    it('should return null when no turn is set', () => {
      const orchestrator = createMockOrchestrator();
      const manager = new BackgroundAgentManager(orchestrator);

      expect(manager.getCurrentTurnId()).toBeNull();
    });

    it('should set and get current turn ID', () => {
      const orchestrator = createMockOrchestrator();
      const manager = new BackgroundAgentManager(orchestrator);

      manager.setCurrentTurn('turn-abc123');
      expect(manager.getCurrentTurnId()).toBe('turn-abc123');
    });

    it('should clear turn ID when set to null', () => {
      const orchestrator = createMockOrchestrator();
      const manager = new BackgroundAgentManager(orchestrator);

      manager.setCurrentTurn('turn-abc123');
      manager.setCurrentTurn(null);
      expect(manager.getCurrentTurnId()).toBeNull();
    });
  });

  describe('Job turnId assignment', () => {
    it('should assign turnId to jobs spawned within a turn', () => {
      const orchestrator = createMockOrchestrator();
      const manager = new BackgroundAgentManager(orchestrator);

      manager.setCurrentTurn('turn-xyz789');
      const jobId = manager.spawn(createSpawnOptions());

      const job = manager.getJob(jobId);
      expect(job?.turnId).toBe('turn-xyz789');
    });

    it('should not assign turnId to jobs spawned outside a turn', () => {
      const orchestrator = createMockOrchestrator();
      const manager = new BackgroundAgentManager(orchestrator);

      const jobId = manager.spawn(createSpawnOptions());

      const job = manager.getJob(jobId);
      expect(job?.turnId).toBeUndefined();
    });

    it('should assign same turnId to multiple jobs in same turn', () => {
      const orchestrator = createMockOrchestrator();
      const manager = new BackgroundAgentManager(orchestrator);

      manager.setCurrentTurn('turn-multi');
      const jobId1 = manager.spawn(createSpawnOptions({ agentName: 'agent-1' }));
      const jobId2 = manager.spawn(createSpawnOptions({ agentName: 'agent-2' }));
      const jobId3 = manager.spawn(createSpawnOptions({ agentName: 'agent-3' }));

      expect(manager.getJob(jobId1)?.turnId).toBe('turn-multi');
      expect(manager.getJob(jobId2)?.turnId).toBe('turn-multi');
      expect(manager.getJob(jobId3)?.turnId).toBe('turn-multi');
    });
  });

  describe('Grouped notifications', () => {
    it('should not push notification until all jobs in group complete', async () => {
      // Create orchestrator with controllable promises
      const resolvers: Array<(result: AgentExecutionResult) => void> = [];
      const orchestrator = {
        delegateToAgent: vi.fn().mockImplementation(() => {
          return new Promise<AgentExecutionResult>(resolve => {
            resolvers.push(resolve);
          });
        }),
      } as unknown as SubagentOrchestrator;

      const manager = new BackgroundAgentManager(orchestrator);

      manager.setCurrentTurn('turn-grouped');
      manager.spawn(createSpawnOptions({ agentName: 'agent-1', task: 'Task 1' }));
      manager.spawn(createSpawnOptions({ agentName: 'agent-2', task: 'Task 2' }));
      manager.setCurrentTurn(null);

      // Complete first job
      resolvers[0]({
        agentName: 'agent-1',
        thoroughness: 'medium',
        summary: 'Result 1',
        parentSessionId: 'test-session',
        resumeId: 'test-resume-id',
        finalAnswer: 'Answer 1',
        steps: [],
        completionInfo: {
          totalTokens: 50,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          iterations: 1,
          toolCalls: 0,
          reachedMaxIterations: false,
        },
      });
      await flushPromises();

      // Should have no notifications yet (waiting for second job)
      expect(manager.drainNotifications()).toHaveLength(0);

      // Complete second job
      resolvers[1]({
        agentName: 'agent-2',
        thoroughness: 'medium',
        summary: 'Result 2',
        parentSessionId: 'test-session',
        resumeId: 'test-resume-id',
        finalAnswer: 'Answer 2',
        steps: [],
        completionInfo: {
          totalTokens: 50,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          iterations: 1,
          toolCalls: 0,
          reachedMaxIterations: false,
        },
      });
      await flushPromises();

      // Now should have one consolidated notification
      const notifications = manager.drainNotifications();
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toContain('[Background Agents Completed]');
      expect(notifications[0]).toContain('2 agents finished');
      expect(notifications[0]).toContain('2 completed');
    });

    it('should include group description in consolidated notification', async () => {
      const orchestrator = createMockOrchestrator();
      const manager = new BackgroundAgentManager(orchestrator);

      manager.setCurrentTurn('turn-with-desc');
      manager.spawn(
        createSpawnOptions({
          agentName: 'explore',
          task: 'Find auth files',
          groupDescription: 'Implementing user authentication',
        })
      );
      manager.setCurrentTurn(null);

      await flushPromises();

      const notifications = manager.drainNotifications();
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toContain('"Implementing user authentication"');
    });

    it('should use first provided group description', async () => {
      const resolvers: Array<(result: AgentExecutionResult) => void> = [];
      const orchestrator = {
        delegateToAgent: vi.fn().mockImplementation(() => {
          return new Promise<AgentExecutionResult>(resolve => {
            resolvers.push(resolve);
          });
        }),
      } as unknown as SubagentOrchestrator;

      const manager = new BackgroundAgentManager(orchestrator);

      manager.setCurrentTurn('turn-first-desc');
      // First agent has no description
      manager.spawn(createSpawnOptions({ agentName: 'agent-1' }));
      // Second agent provides description
      manager.spawn(
        createSpawnOptions({
          agentName: 'agent-2',
          groupDescription: 'Adding new feature',
        })
      );
      // Third agent tries to override (should be ignored)
      manager.spawn(
        createSpawnOptions({
          agentName: 'agent-3',
          groupDescription: 'Different description',
        })
      );
      manager.setCurrentTurn(null);

      // Complete all jobs
      const result: AgentExecutionResult = {
        agentName: 'test',
        thoroughness: 'medium',
        summary: 'Done',
        parentSessionId: 'test-session',
        resumeId: 'test-resume-id',
        finalAnswer: 'Done',
        steps: [],
        completionInfo: {
          totalTokens: 50,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          iterations: 1,
          toolCalls: 0,
          reachedMaxIterations: false,
        },
      };
      resolvers.forEach(r => r(result));
      await flushPromises();

      const notifications = manager.drainNotifications();
      expect(notifications[0]).toContain('"Adding new feature"');
      expect(notifications[0]).not.toContain('Different description');
    });

    it('should format notification without description if none provided', async () => {
      const orchestrator = createMockOrchestrator();
      const manager = new BackgroundAgentManager(orchestrator);

      manager.setCurrentTurn('turn-no-desc');
      manager.spawn(createSpawnOptions({ agentName: 'explore' }));
      manager.setCurrentTurn(null);

      await flushPromises();

      const notifications = manager.drainNotifications();
      expect(notifications).toHaveLength(1);
      // Header should NOT have quotes (no group description)
      const headerLine = notifications[0].split('\n')[0];
      expect(headerLine).toMatch(/^\[Background Agents Completed\] 1 agent finished/);
      expect(headerLine).not.toContain('"');
    });

    it('should handle mixed completed and failed jobs in group', async () => {
      let callCount = 0;
      const orchestrator = {
        delegateToAgent: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            return Promise.resolve({
              agentName: 'agent-1',
              thoroughness: 'medium',
              summary: 'Success result',
              parentSessionId: 'test-session',
              resumeId: 'test-resume-id',
              finalAnswer: 'Done',
              steps: [],
              completionInfo: {
                totalTokens: 50,
                totalInputTokens: 0,
                totalOutputTokens: 0,
                iterations: 1,
                toolCalls: 0,
                reachedMaxIterations: false,
              },
            });
          } else {
            return Promise.reject(new Error('Agent failed'));
          }
        }),
      } as unknown as SubagentOrchestrator;

      const manager = new BackgroundAgentManager(orchestrator);

      manager.setCurrentTurn('turn-mixed');
      manager.spawn(createSpawnOptions({ agentName: 'agent-1', task: 'Task that succeeds' }));
      manager.spawn(createSpawnOptions({ agentName: 'agent-2', task: 'Task that fails' }));
      manager.setCurrentTurn(null);

      // Wait for both to complete (one success, one failure)
      await waitForAllJobsTerminal(manager);

      const notifications = manager.drainNotifications();
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toContain('1 completed');
      expect(notifications[0]).toContain('1 failed');
      expect(notifications[0]).toContain('COMPLETED');
      expect(notifications[0]).toContain('FAILED');
    });

    it('should include individual job details in consolidated notification', async () => {
      const orchestrator = createMockOrchestrator({
        resolveWith: {
          agentName: 'explore',
          thoroughness: 'medium',
          summary: 'Found 5 authentication files in src/auth/',
          parentSessionId: 'test-session',
          resumeId: 'test-resume-id',
          finalAnswer: 'Done',
          steps: [],
          completionInfo: {
            totalTokens: 100,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            iterations: 2,
            toolCalls: 3,
            reachedMaxIterations: false,
          },
        },
      });
      const manager = new BackgroundAgentManager(orchestrator);

      manager.setCurrentTurn('turn-details');
      manager.spawn(
        createSpawnOptions({
          agentName: 'explore',
          task: 'Find all authentication files',
        })
      );
      manager.setCurrentTurn(null);

      await flushPromises();

      const notifications = manager.drainNotifications();
      expect(notifications[0]).toContain('Agent "explore"');
      expect(notifications[0]).toContain('Task: Find all authentication files');
      expect(notifications[0]).toContain('Found 5 authentication files');
    });
  });

  describe('Legacy behavior (no turnId)', () => {
    it('should push immediate notification for jobs without turnId', async () => {
      const orchestrator = createMockOrchestrator({
        resolveWith: {
          agentName: 'explore',
          thoroughness: 'medium',
          summary: 'Immediate result',
          parentSessionId: 'test-session',
          resumeId: 'test-resume-id',
          finalAnswer: 'Done',
          steps: [],
          completionInfo: {
            totalTokens: 50,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            iterations: 1,
            toolCalls: 0,
            reachedMaxIterations: false,
          },
        },
      });
      const manager = new BackgroundAgentManager(orchestrator);

      // No setCurrentTurn - legacy behavior
      manager.spawn(createSpawnOptions({ agentName: 'explore', task: 'Legacy task' }));

      await flushPromises();

      const notifications = manager.drainNotifications();
      expect(notifications).toHaveLength(1);
      // Legacy format is different from grouped format
      expect(notifications[0]).toContain('Immediate result');
    });
  });

  describe('Concurrency control with grouped jobs', () => {
    it('should respect maxConcurrent for grouped jobs', () => {
      const orchestrator = createMockOrchestrator({ delay: 1000 });
      const manager = new BackgroundAgentManager(orchestrator, 2);

      manager.setCurrentTurn('turn-concurrent');
      const jobId1 = manager.spawn(createSpawnOptions({ agentName: 'agent-1' }));
      const jobId2 = manager.spawn(createSpawnOptions({ agentName: 'agent-2' }));
      const jobId3 = manager.spawn(createSpawnOptions({ agentName: 'agent-3' }));
      manager.setCurrentTurn(null);

      // First two should be running, third should be queued
      expect(manager.getJob(jobId1)?.status).toBe('running');
      expect(manager.getJob(jobId2)?.status).toBe('running');
      expect(manager.getJob(jobId3)?.status).toBe('queued');

      // All should have same turnId
      expect(manager.getJob(jobId1)?.turnId).toBe('turn-concurrent');
      expect(manager.getJob(jobId2)?.turnId).toBe('turn-concurrent');
      expect(manager.getJob(jobId3)?.turnId).toBe('turn-concurrent');
    });
  });

  describe('Single agent in group', () => {
    it('should handle single agent in a turn group', async () => {
      const orchestrator = createMockOrchestrator({
        resolveWith: {
          agentName: 'explore',
          thoroughness: 'quick',
          summary: 'Single agent result',
          parentSessionId: 'test-session',
          resumeId: 'test-resume-id',
          finalAnswer: 'Done',
          steps: [],
          completionInfo: {
            totalTokens: 30,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            iterations: 1,
            toolCalls: 1,
            reachedMaxIterations: false,
          },
        },
      });
      const manager = new BackgroundAgentManager(orchestrator);

      manager.setCurrentTurn('turn-single');
      manager.spawn(
        createSpawnOptions({
          agentName: 'explore',
          task: 'Single task',
          groupDescription: 'Quick lookup',
        })
      );
      manager.setCurrentTurn(null);

      await flushPromises();

      const notifications = manager.drainNotifications();
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toContain('[Background Agents Completed]');
      expect(notifications[0]).toContain('1 agent finished');
      expect(notifications[0]).toContain('"Quick lookup"');
    });
  });

  describe('Status callback with turnId', () => {
    it('should include turnId in status change callbacks', () => {
      const orchestrator = createMockOrchestrator();
      const manager = new BackgroundAgentManager(orchestrator);
      const statusChanges: Array<{ id: string; turnId?: string }> = [];

      manager.setOnStatusChange(job => {
        statusChanges.push({ id: job.id, turnId: job.turnId });
      });

      manager.setCurrentTurn('turn-callback');
      const jobId = manager.spawn(createSpawnOptions());
      manager.setCurrentTurn(null);

      // Should have received initial status with turnId
      expect(statusChanges.some(s => s.id === jobId && s.turnId === 'turn-callback')).toBe(true);
    });
  });

  describe('Multiple turn groups', () => {
    it('should handle multiple independent turn groups', async () => {
      const resolvers: Array<(result: AgentExecutionResult) => void> = [];
      const orchestrator = {
        delegateToAgent: vi.fn().mockImplementation(() => {
          return new Promise<AgentExecutionResult>(resolve => {
            resolvers.push(resolve);
          });
        }),
      } as unknown as SubagentOrchestrator;

      const manager = new BackgroundAgentManager(orchestrator);

      // First turn group
      manager.setCurrentTurn('turn-group-1');
      manager.spawn(createSpawnOptions({ agentName: 'agent-1a', groupDescription: 'Group 1' }));
      manager.setCurrentTurn(null);

      // Second turn group
      manager.setCurrentTurn('turn-group-2');
      manager.spawn(createSpawnOptions({ agentName: 'agent-2a', groupDescription: 'Group 2' }));
      manager.setCurrentTurn(null);

      // Complete second group first
      resolvers[1]({
        agentName: 'agent-2a',
        thoroughness: 'medium',
        summary: 'Group 2 result',
        parentSessionId: 'test-session',
        resumeId: 'test-resume-id',
        finalAnswer: 'Done',
        steps: [],
        completionInfo: {
          totalTokens: 50,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          iterations: 1,
          toolCalls: 0,
          reachedMaxIterations: false,
        },
      });
      await flushPromises();

      let notifications = manager.drainNotifications();
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toContain('"Group 2"');

      // Complete first group
      resolvers[0]({
        agentName: 'agent-1a',
        thoroughness: 'medium',
        summary: 'Group 1 result',
        parentSessionId: 'test-session',
        resumeId: 'test-resume-id',
        finalAnswer: 'Done',
        steps: [],
        completionInfo: {
          totalTokens: 50,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          iterations: 1,
          toolCalls: 0,
          reachedMaxIterations: false,
        },
      });
      await flushPromises();

      notifications = manager.drainNotifications();
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toContain('"Group 1"');
    });
  });

  describe('Notification format', () => {
    it('should use singular "agent" for single agent', async () => {
      const orchestrator = createMockOrchestrator();
      const manager = new BackgroundAgentManager(orchestrator);

      manager.setCurrentTurn('turn-singular');
      manager.spawn(createSpawnOptions());
      manager.setCurrentTurn(null);

      await flushPromises();

      const notifications = manager.drainNotifications();
      expect(notifications[0]).toContain('1 agent finished');
      expect(notifications[0]).not.toContain('1 agents');
    });

    it('should use plural "agents" for multiple agents', async () => {
      const resolvers: Array<(result: AgentExecutionResult) => void> = [];
      const orchestrator = {
        delegateToAgent: vi.fn().mockImplementation(() => {
          return new Promise<AgentExecutionResult>(resolve => {
            resolvers.push(resolve);
          });
        }),
      } as unknown as SubagentOrchestrator;

      const manager = new BackgroundAgentManager(orchestrator);

      manager.setCurrentTurn('turn-plural');
      manager.spawn(createSpawnOptions({ agentName: 'agent-1' }));
      manager.spawn(createSpawnOptions({ agentName: 'agent-2' }));
      manager.setCurrentTurn(null);

      const result: AgentExecutionResult = {
        agentName: 'test',
        thoroughness: 'medium',
        summary: 'Done',
        parentSessionId: 'test-session',
        resumeId: 'test-resume-id',
        finalAnswer: 'Done',
        steps: [],
        completionInfo: {
          totalTokens: 50,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          iterations: 1,
          toolCalls: 0,
          reachedMaxIterations: false,
        },
      };
      resolvers.forEach(r => r(result));
      await flushPromises();

      const notifications = manager.drainNotifications();
      expect(notifications[0]).toContain('2 agents finished');
    });

    it('should show Result label for completed jobs', async () => {
      const orchestrator = createMockOrchestrator({
        resolveWith: {
          agentName: 'explore',
          thoroughness: 'medium',
          summary: 'Success content',
          parentSessionId: 'test-session',
          resumeId: 'test-resume-id',
          finalAnswer: 'Done',
          steps: [],
          completionInfo: {
            totalTokens: 50,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            iterations: 1,
            toolCalls: 0,
            reachedMaxIterations: false,
          },
        },
      });
      const manager = new BackgroundAgentManager(orchestrator);

      manager.setCurrentTurn('turn-result-label');
      manager.spawn(createSpawnOptions());
      manager.setCurrentTurn(null);

      await flushPromises();

      const notifications = manager.drainNotifications();
      expect(notifications[0]).toContain('Result:\nSuccess content');
    });

    it('should show Error label for failed jobs', async () => {
      const orchestrator = {
        delegateToAgent: vi.fn().mockRejectedValue(new Error('Something went wrong')),
      } as unknown as SubagentOrchestrator;

      const manager = new BackgroundAgentManager(orchestrator);

      manager.setCurrentTurn('turn-error-label');
      manager.spawn(createSpawnOptions());
      manager.setCurrentTurn(null);

      await waitForAllJobsTerminal(manager);

      const notifications = manager.drainNotifications();
      expect(notifications[0]).toContain('Error:\nSomething went wrong');
    });
  });

  describe('Basic operations', () => {
    it('should generate unique job IDs', () => {
      const orchestrator = createMockOrchestrator({ delay: 1000 });
      const manager = new BackgroundAgentManager(orchestrator);

      const ids = new Set<string>();
      for (let i = 0; i < 10; i++) {
        ids.add(manager.spawn(createSpawnOptions()));
      }

      expect(ids.size).toBe(10);
    });

    it('should return job by ID via getJob', () => {
      const orchestrator = createMockOrchestrator({ delay: 1000 });
      const manager = new BackgroundAgentManager(orchestrator);

      const jobId = manager.spawn(createSpawnOptions({ agentName: 'my-agent', task: 'my-task' }));
      const job = manager.getJob(jobId);

      expect(job).toBeDefined();
      expect(job?.id).toBe(jobId);
      expect(job?.agentName).toBe('my-agent');
      expect(job?.task).toBe('my-task');
    });

    it('should return undefined for non-existent job ID', () => {
      const orchestrator = createMockOrchestrator();
      const manager = new BackgroundAgentManager(orchestrator);

      expect(manager.getJob('non-existent-id')).toBeUndefined();
    });

    it('should list all jobs via listJobs', () => {
      const orchestrator = createMockOrchestrator({ delay: 1000 });
      const manager = new BackgroundAgentManager(orchestrator);

      manager.spawn(createSpawnOptions({ agentName: 'agent-1' }));
      manager.spawn(createSpawnOptions({ agentName: 'agent-2' }));
      manager.spawn(createSpawnOptions({ agentName: 'agent-3' }));

      const jobs = manager.listJobs();
      expect(jobs).toHaveLength(3);
      expect(jobs.map(j => j.agentName)).toContain('agent-1');
      expect(jobs.map(j => j.agentName)).toContain('agent-2');
      expect(jobs.map(j => j.agentName)).toContain('agent-3');
    });

    it('should return empty list when no jobs exist', () => {
      const orchestrator = createMockOrchestrator();
      const manager = new BackgroundAgentManager(orchestrator);

      expect(manager.listJobs()).toEqual([]);
    });

    it('should return result via getResult after completion', async () => {
      const expectedResult: AgentExecutionResult = {
        agentName: 'explore',
        thoroughness: 'medium',
        summary: 'Found important files',
        parentSessionId: 'test-session',
        resumeId: 'test-resume-id',
        finalAnswer: 'Done',
        steps: [],
        completionInfo: {
          totalTokens: 100,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          iterations: 2,
          toolCalls: 5,
          reachedMaxIterations: false,
        },
      };
      const orchestrator = createMockOrchestrator({ resolveWith: expectedResult });
      const manager = new BackgroundAgentManager(orchestrator);

      const jobId = manager.spawn(createSpawnOptions());
      await flushPromises();

      const result = manager.getResult(jobId);
      expect(result).toBeDefined();
      expect(result?.summary).toBe('Found important files');
      expect(result?.completionInfo.toolCalls).toBe(5);
    });

    it('should return undefined result for incomplete job', () => {
      const orchestrator = createMockOrchestrator({ delay: 1000 });
      const manager = new BackgroundAgentManager(orchestrator);

      const jobId = manager.spawn(createSpawnOptions());
      expect(manager.getResult(jobId)).toBeUndefined();
    });

    it('should clear notifications on drain', async () => {
      const orchestrator = createMockOrchestrator();
      const manager = new BackgroundAgentManager(orchestrator);

      // Spawn without turn (legacy mode - immediate notification)
      manager.spawn(createSpawnOptions());
      await flushPromises();

      // First drain should have notifications
      const first = manager.drainNotifications();
      expect(first.length).toBeGreaterThan(0);

      // Second drain should be empty
      const second = manager.drainNotifications();
      expect(second).toEqual([]);
    });
  });

  describe('Concurrency control', () => {
    it('should respect maxConcurrent limit', () => {
      const orchestrator = createMockOrchestrator({ delay: 1000 });
      const manager = new BackgroundAgentManager(orchestrator, 2);

      const job1 = manager.spawn(createSpawnOptions({ agentName: 'agent-1' }));
      const job2 = manager.spawn(createSpawnOptions({ agentName: 'agent-2' }));
      const job3 = manager.spawn(createSpawnOptions({ agentName: 'agent-3' }));
      const job4 = manager.spawn(createSpawnOptions({ agentName: 'agent-4' }));

      expect(manager.getJob(job1)?.status).toBe('running');
      expect(manager.getJob(job2)?.status).toBe('running');
      expect(manager.getJob(job3)?.status).toBe('queued');
      expect(manager.getJob(job4)?.status).toBe('queued');
    });

    it('should use default maxConcurrent of 4', () => {
      const orchestrator = createMockOrchestrator({ delay: 1000 });
      const manager = new BackgroundAgentManager(orchestrator);

      const jobs: string[] = [];
      for (let i = 0; i < 6; i++) {
        jobs.push(manager.spawn(createSpawnOptions({ agentName: `agent-${i}` })));
      }

      // First 4 should be running
      expect(manager.getJob(jobs[0])?.status).toBe('running');
      expect(manager.getJob(jobs[1])?.status).toBe('running');
      expect(manager.getJob(jobs[2])?.status).toBe('running');
      expect(manager.getJob(jobs[3])?.status).toBe('running');
      // Rest should be queued
      expect(manager.getJob(jobs[4])?.status).toBe('queued');
      expect(manager.getJob(jobs[5])?.status).toBe('queued');
    });

    it('should start queued jobs when running jobs complete', async () => {
      const resolvers: Array<(result: AgentExecutionResult) => void> = [];
      const orchestrator = {
        delegateToAgent: vi.fn().mockImplementation(() => {
          return new Promise<AgentExecutionResult>(resolve => {
            resolvers.push(resolve);
          });
        }),
      } as unknown as SubagentOrchestrator;

      const manager = new BackgroundAgentManager(orchestrator, 2);

      const job1 = manager.spawn(createSpawnOptions({ agentName: 'agent-1' }));
      const job2 = manager.spawn(createSpawnOptions({ agentName: 'agent-2' }));
      const job3 = manager.spawn(createSpawnOptions({ agentName: 'agent-3' }));

      // First two should be running, third should be queued
      expect(manager.getJob(job1)?.status).toBe('running');
      expect(manager.getJob(job2)?.status).toBe('running');
      expect(manager.getJob(job3)?.status).toBe('queued');

      // Complete job1
      resolvers[0]({
        agentName: 'agent-1',
        thoroughness: 'medium',
        summary: 'Done',
        parentSessionId: 'test-session',
        resumeId: 'test-resume-id',
        finalAnswer: 'Done',
        steps: [],
        completionInfo: {
          totalTokens: 50,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          iterations: 1,
          toolCalls: 0,
          reachedMaxIterations: false,
        },
      });
      await flushPromises();

      // job3 should now be running
      expect(manager.getJob(job1)?.status).toBe('completed');
      expect(manager.getJob(job3)?.status).toBe('running');
    });

    it('should process queue in FIFO order', async () => {
      const resolvers: Array<(result: AgentExecutionResult) => void> = [];
      const orchestrator = {
        delegateToAgent: vi.fn().mockImplementation(() => {
          return new Promise<AgentExecutionResult>(resolve => {
            resolvers.push(resolve);
          });
        }),
      } as unknown as SubagentOrchestrator;

      const manager = new BackgroundAgentManager(orchestrator, 1);
      const transitionOrder: string[] = [];
      const seen = new Set<string>();

      manager.setOnStatusChange(job => {
        // Track unique transitions to 'running' status (dedupe repeated notifications)
        if (job.status === 'running') {
          const key = `${job.agentName}-running`;
          if (!seen.has(key)) {
            seen.add(key);
            transitionOrder.push(job.agentName);
          }
        }
      });

      manager.spawn(createSpawnOptions({ agentName: 'first' }));
      manager.spawn(createSpawnOptions({ agentName: 'second' }));
      manager.spawn(createSpawnOptions({ agentName: 'third' }));

      // First job starts immediately
      expect(transitionOrder).toEqual(['first']);

      const result: AgentExecutionResult = {
        agentName: 'test',
        thoroughness: 'medium',
        summary: 'Done',
        parentSessionId: 'test-session',
        resumeId: 'test-resume-id',
        finalAnswer: 'Done',
        steps: [],
        completionInfo: {
          totalTokens: 50,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          iterations: 1,
          toolCalls: 0,
          reachedMaxIterations: false,
        },
      };

      // Complete first job
      resolvers[0](result);
      await flushPromises();
      expect(transitionOrder).toEqual(['first', 'second']);

      // Complete second job
      resolvers[1](result);
      await flushPromises();
      expect(transitionOrder).toEqual(['first', 'second', 'third']);
    });

    it('should start multiple queued jobs when multiple slots open', async () => {
      const resolvers: Array<(result: AgentExecutionResult) => void> = [];
      const orchestrator = {
        delegateToAgent: vi.fn().mockImplementation(() => {
          return new Promise<AgentExecutionResult>(resolve => {
            resolvers.push(resolve);
          });
        }),
      } as unknown as SubagentOrchestrator;

      const manager = new BackgroundAgentManager(orchestrator, 2);

      const jobs = [
        manager.spawn(createSpawnOptions({ agentName: 'agent-1' })),
        manager.spawn(createSpawnOptions({ agentName: 'agent-2' })),
        manager.spawn(createSpawnOptions({ agentName: 'agent-3' })),
        manager.spawn(createSpawnOptions({ agentName: 'agent-4' })),
      ];

      // jobs 3 and 4 should be queued
      expect(manager.getJob(jobs[2])?.status).toBe('queued');
      expect(manager.getJob(jobs[3])?.status).toBe('queued');

      const result: AgentExecutionResult = {
        agentName: 'test',
        thoroughness: 'medium',
        summary: 'Done',
        parentSessionId: 'test-session',
        resumeId: 'test-resume-id',
        finalAnswer: 'Done',
        steps: [],
        completionInfo: {
          totalTokens: 50,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          iterations: 1,
          toolCalls: 0,
          reachedMaxIterations: false,
        },
      };

      // Complete both running jobs nearly simultaneously
      resolvers[0](result);
      resolvers[1](result);
      await flushPromises();

      // Both queued jobs should now be running
      expect(manager.getJob(jobs[2])?.status).toBe('running');
      expect(manager.getJob(jobs[3])?.status).toBe('running');
    });
  });

  describe('Cancel operations', () => {
    it('should cancel a queued job', () => {
      const orchestrator = createMockOrchestrator({ delay: 1000 });
      const manager = new BackgroundAgentManager(orchestrator, 1);

      manager.spawn(createSpawnOptions({ agentName: 'running' }));
      const queuedJobId = manager.spawn(createSpawnOptions({ agentName: 'queued' }));

      expect(manager.getJob(queuedJobId)?.status).toBe('queued');

      const cancelled = manager.cancelJob(queuedJobId);

      expect(cancelled).toBe(true);
      expect(manager.getJob(queuedJobId)?.status).toBe('cancelled');
      expect(manager.getJob(queuedJobId)?.endTime).toBeDefined();
    });

    it('should cancel a running job', async () => {
      const orchestrator = createMockOrchestrator({ delay: 10000 });
      const manager = new BackgroundAgentManager(orchestrator, 1);

      const jobId = manager.spawn(createSpawnOptions());
      expect(manager.getJob(jobId)?.status).toBe('running');

      const cancelled = manager.cancelJob(jobId);

      expect(cancelled).toBe(true);
      expect(manager.getJob(jobId)?.status).toBe('cancelled');
    });

    it('should return false when cancelling non-existent job', () => {
      const orchestrator = createMockOrchestrator();
      const manager = new BackgroundAgentManager(orchestrator);

      expect(manager.cancelJob('non-existent')).toBe(false);
    });

    it('should return false when cancelling already completed job', async () => {
      const orchestrator = createMockOrchestrator();
      const manager = new BackgroundAgentManager(orchestrator);

      const jobId = manager.spawn(createSpawnOptions());
      await flushPromises();

      expect(manager.getJob(jobId)?.status).toBe('completed');
      expect(manager.cancelJob(jobId)).toBe(false);
    });

    it('should return false when cancelling already cancelled job', () => {
      const orchestrator = createMockOrchestrator({ delay: 1000 });
      const manager = new BackgroundAgentManager(orchestrator, 1);

      manager.spawn(createSpawnOptions());
      const jobId = manager.spawn(createSpawnOptions());

      manager.cancelJob(jobId);
      expect(manager.cancelJob(jobId)).toBe(false);
    });

    it('should remove cancelled job from queue', () => {
      const orchestrator = createMockOrchestrator({ delay: 1000 });
      const manager = new BackgroundAgentManager(orchestrator, 1);

      manager.spawn(createSpawnOptions({ agentName: 'running' }));
      const queued1 = manager.spawn(createSpawnOptions({ agentName: 'queued-1' }));
      const queued2 = manager.spawn(createSpawnOptions({ agentName: 'queued-2' }));

      manager.cancelJob(queued1);

      // queued2 should still be in queue
      expect(manager.getJob(queued2)?.status).toBe('queued');
    });

    it('should pass an AbortSignal to delegateToAgent so retries can be cancelled', () => {
      const orchestrator = createMockOrchestrator({ delay: 10000 });
      const manager = new BackgroundAgentManager(orchestrator);

      manager.spawn(createSpawnOptions());

      expect(orchestrator.delegateToAgent).toHaveBeenCalledWith(
        expect.objectContaining({ abortSignal: expect.any(AbortSignal) })
      );
    });

    it('should pass an unaborted signal at job start', () => {
      const orchestrator = createMockOrchestrator({ delay: 10000 });
      const manager = new BackgroundAgentManager(orchestrator);

      manager.spawn(createSpawnOptions());

      const callArg = (orchestrator.delegateToAgent as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArg.abortSignal.aborted).toBe(false);
    });

    it('should start next queued job when running job is cancelled', async () => {
      const resolvers: Array<(result: AgentExecutionResult) => void> = [];
      const orchestrator = {
        delegateToAgent: vi.fn().mockImplementation(() => {
          return new Promise<AgentExecutionResult>(resolve => {
            resolvers.push(resolve);
          });
        }),
      } as unknown as SubagentOrchestrator;

      const manager = new BackgroundAgentManager(orchestrator, 1);

      const runningJob = manager.spawn(createSpawnOptions({ agentName: 'running' }));
      const queuedJob = manager.spawn(createSpawnOptions({ agentName: 'queued' }));

      expect(manager.getJob(queuedJob)?.status).toBe('queued');

      // Cancel the running job
      manager.cancelJob(runningJob);
      await flushPromises();

      // Queued job should now be running
      expect(manager.getJob(queuedJob)?.status).toBe('running');
    });
  });

  describe('Rapid spawn/cancel', () => {
    it('should handle rapid spawning', () => {
      const orchestrator = createMockOrchestrator({ delay: 1000 });
      const manager = new BackgroundAgentManager(orchestrator, 2);

      const jobs: string[] = [];
      for (let i = 0; i < 20; i++) {
        jobs.push(manager.spawn(createSpawnOptions({ agentName: `agent-${i}` })));
      }

      expect(manager.listJobs()).toHaveLength(20);

      const running = manager.listJobs().filter(j => j.status === 'running');
      const queued = manager.listJobs().filter(j => j.status === 'queued');

      expect(running).toHaveLength(2);
      expect(queued).toHaveLength(18);
    });

    it('should handle rapid cancellation of queued jobs', () => {
      const orchestrator = createMockOrchestrator({ delay: 1000 });
      const manager = new BackgroundAgentManager(orchestrator, 1);

      const runningJob = manager.spawn(createSpawnOptions({ agentName: 'running' }));
      const queuedJobs: string[] = [];
      for (let i = 0; i < 10; i++) {
        queuedJobs.push(manager.spawn(createSpawnOptions({ agentName: `queued-${i}` })));
      }

      // Cancel all queued jobs rapidly
      queuedJobs.forEach(id => manager.cancelJob(id));

      // All queued jobs should be cancelled
      queuedJobs.forEach(id => {
        expect(manager.getJob(id)?.status).toBe('cancelled');
      });

      // Running job should still be running
      expect(manager.getJob(runningJob)?.status).toBe('running');
    });

    it('should handle spawn immediately followed by cancel', () => {
      const orchestrator = createMockOrchestrator({ delay: 1000 });
      const manager = new BackgroundAgentManager(orchestrator, 1);

      // Occupy the slot
      manager.spawn(createSpawnOptions({ agentName: 'blocker' }));

      // Spawn and immediately cancel
      const jobId = manager.spawn(createSpawnOptions({ agentName: 'quick-cancel' }));
      expect(manager.getJob(jobId)?.status).toBe('queued');

      const cancelled = manager.cancelJob(jobId);
      expect(cancelled).toBe(true);
      expect(manager.getJob(jobId)?.status).toBe('cancelled');
    });
  });

  describe('Status callback', () => {
    it('should fire callback on job creation', () => {
      const orchestrator = createMockOrchestrator({ delay: 1000 });
      const manager = new BackgroundAgentManager(orchestrator);
      const changes: Array<{ id: string; status: string }> = [];

      manager.setOnStatusChange(job => {
        changes.push({ id: job.id, status: job.status });
      });

      const jobId = manager.spawn(createSpawnOptions());

      // Callback fires at least once on creation (may fire multiple times due to startJob)
      expect(changes.length).toBeGreaterThanOrEqual(1);
      expect(changes[0].id).toBe(jobId);
      expect(changes[0].status).toBe('running');
    });

    it('should fire callback on status transitions', async () => {
      const orchestrator = createMockOrchestrator();
      const manager = new BackgroundAgentManager(orchestrator);
      const statuses: string[] = [];

      manager.setOnStatusChange(job => {
        statuses.push(job.status);
      });

      manager.spawn(createSpawnOptions());
      await flushPromises();

      expect(statuses).toContain('running');
      expect(statuses).toContain('completed');
    });

    it('should fire callback for queued then running transition', async () => {
      const resolvers: Array<(result: AgentExecutionResult) => void> = [];
      const orchestrator = {
        delegateToAgent: vi.fn().mockImplementation(() => {
          return new Promise<AgentExecutionResult>(resolve => {
            resolvers.push(resolve);
          });
        }),
      } as unknown as SubagentOrchestrator;

      const manager = new BackgroundAgentManager(orchestrator, 1);
      const changes: Array<{ agentName: string; status: string }> = [];

      manager.setOnStatusChange(job => {
        changes.push({ agentName: job.agentName, status: job.status });
      });

      manager.spawn(createSpawnOptions({ agentName: 'first' }));
      manager.spawn(createSpawnOptions({ agentName: 'second' }));

      // Second job should be queued initially
      expect(changes.filter(c => c.agentName === 'second' && c.status === 'queued')).toHaveLength(1);

      // Complete first job
      resolvers[0]({
        agentName: 'first',
        thoroughness: 'medium',
        summary: 'Done',
        parentSessionId: 'test-session',
        resumeId: 'test-resume-id',
        finalAnswer: 'Done',
        steps: [],
        completionInfo: {
          totalTokens: 50,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          iterations: 1,
          toolCalls: 0,
          reachedMaxIterations: false,
        },
      });
      await flushPromises();

      // Second job should have transitioned to running
      expect(changes.filter(c => c.agentName === 'second' && c.status === 'running')).toHaveLength(1);
    });

    it('should be able to clear callback', () => {
      const orchestrator = createMockOrchestrator({ delay: 1000 });
      const manager = new BackgroundAgentManager(orchestrator);
      const changes: string[] = [];

      manager.setOnStatusChange(() => {
        changes.push('called');
      });

      manager.spawn(createSpawnOptions());
      const countAfterFirstSpawn = changes.length;
      expect(countAfterFirstSpawn).toBeGreaterThanOrEqual(1);

      manager.setOnStatusChange(null);

      manager.spawn(createSpawnOptions());
      // Count should not have increased after clearing callback
      expect(changes).toHaveLength(countAfterFirstSpawn);
    });
  });

  describe('Error handling', () => {
    it('should handle job failure gracefully', async () => {
      const orchestrator = {
        delegateToAgent: vi.fn().mockRejectedValue(new Error('Agent crashed')),
      } as unknown as SubagentOrchestrator;

      const manager = new BackgroundAgentManager(orchestrator);

      const jobId = manager.spawn(createSpawnOptions());
      await waitForAllJobsTerminal(manager);

      const job = manager.getJob(jobId);
      expect(job?.status).toBe('failed');
      expect(job?.error).toBe('Agent crashed');
      expect(job?.endTime).toBeDefined();
    });

    it('should handle non-Error rejections', async () => {
      const orchestrator = {
        delegateToAgent: vi.fn().mockRejectedValue('String error'),
      } as unknown as SubagentOrchestrator;

      const manager = new BackgroundAgentManager(orchestrator);

      const jobId = manager.spawn(createSpawnOptions());
      await waitForAllJobsTerminal(manager);

      const job = manager.getJob(jobId);
      expect(job?.status).toBe('failed');
      expect(job?.error).toBe('String error');
    });

    it('should continue processing queue after job failure', async () => {
      let callCount = 0;
      const orchestrator = {
        delegateToAgent: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            return Promise.reject(new Error('First fails'));
          }
          return Promise.resolve({
            agentName: 'agent',
            thoroughness: 'medium',
            summary: 'Success',
            parentSessionId: 'test-session',
            resumeId: 'test-resume-id',
            finalAnswer: 'Done',
            steps: [],
            completionInfo: {
              totalTokens: 50,
              totalInputTokens: 0,
              totalOutputTokens: 0,
              iterations: 1,
              toolCalls: 0,
              reachedMaxIterations: false,
            },
          });
        }),
      } as unknown as SubagentOrchestrator;

      const manager = new BackgroundAgentManager(orchestrator, 1);

      const job1 = manager.spawn(createSpawnOptions({ agentName: 'will-fail' }));
      const job2 = manager.spawn(createSpawnOptions({ agentName: 'will-succeed' }));

      await waitForAllJobsTerminal(manager);

      expect(manager.getJob(job1)?.status).toBe('failed');
      expect(manager.getJob(job2)?.status).toBe('completed');
    });
  });

  describe('Job metadata', () => {
    it('should set startTime on job creation', () => {
      const orchestrator = createMockOrchestrator({ delay: 1000 });
      const manager = new BackgroundAgentManager(orchestrator);

      const before = Date.now();
      const jobId = manager.spawn(createSpawnOptions());
      const after = Date.now();

      const job = manager.getJob(jobId);
      expect(job?.startTime).toBeGreaterThanOrEqual(before);
      expect(job?.startTime).toBeLessThanOrEqual(after);
    });

    it('should set endTime on job completion', async () => {
      const orchestrator = createMockOrchestrator();
      const manager = new BackgroundAgentManager(orchestrator);

      const jobId = manager.spawn(createSpawnOptions());
      await flushPromises();

      const job = manager.getJob(jobId);
      expect(job?.endTime).toBeDefined();
      expect(job?.endTime).toBeGreaterThanOrEqual(job?.startTime ?? 0);
    });

    it('should set resultSummary on successful completion', async () => {
      const orchestrator = createMockOrchestrator({
        resolveWith: {
          agentName: 'explore',
          thoroughness: 'medium',
          summary: 'Found 10 matching files',
          parentSessionId: 'test-session',
          resumeId: 'test-resume-id',
          finalAnswer: 'Done',
          steps: [],
          completionInfo: {
            totalTokens: 100,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            iterations: 1,
            toolCalls: 0,
            reachedMaxIterations: false,
          },
        },
      });
      const manager = new BackgroundAgentManager(orchestrator);

      const jobId = manager.spawn(createSpawnOptions());
      await flushPromises();

      const job = manager.getJob(jobId);
      expect(job?.resultSummary).toBe('Found 10 matching files');
    });
  });

  describe('spawnWithFuture', () => {
    it('should return jobId and a result promise', () => {
      const orchestrator = createMockOrchestrator();
      const manager = new BackgroundAgentManager(orchestrator);

      const { jobId, result } = manager.spawnWithFuture(createSpawnOptions());

      expect(jobId).toMatch(/^bg-/);
      expect(result).toBeInstanceOf(Promise);
    });

    it('should resolve the promise when the job completes', async () => {
      const expectedResult: AgentExecutionResult = {
        agentName: 'test-agent',
        thoroughness: 'medium',
        summary: 'Future result',
        parentSessionId: 'test-session',
        resumeId: 'test-resume-id',
        finalAnswer: 'Done',
        steps: [],
        completionInfo: {
          totalTokens: 50,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          iterations: 1,
          toolCalls: 0,
          reachedMaxIterations: false,
        },
      };

      const orchestrator = createMockOrchestrator({ resolveWith: expectedResult });
      const manager = new BackgroundAgentManager(orchestrator);

      const { result } = manager.spawnWithFuture(createSpawnOptions());
      const resolved = await result;

      expect(resolved.summary).toBe('Future result');
      expect(resolved.agentName).toBe('test-agent');
    });

    it('should reject the promise when the job fails', async () => {
      const orchestrator = createMockOrchestrator({ rejectWith: new Error('Agent crashed') });
      const manager = new BackgroundAgentManager(orchestrator);

      const { result } = manager.spawnWithFuture(createSpawnOptions());

      await expect(result).rejects.toThrow('Agent crashed');
    });

    it('should reject the promise when the job is cancelled', async () => {
      const orchestrator = createMockOrchestrator({ delay: 500 });
      const manager = new BackgroundAgentManager(orchestrator);

      const { jobId, result } = manager.spawnWithFuture(createSpawnOptions());
      manager.cancelJob(jobId);

      await expect(result).rejects.toThrow('cancelled');
    });

    it('should work alongside regular spawn', async () => {
      const orchestrator = createMockOrchestrator();
      const manager = new BackgroundAgentManager(orchestrator);

      // Regular spawn still works
      const regularId = manager.spawn(createSpawnOptions());
      expect(regularId).toMatch(/^bg-/);

      // spawnWithFuture also works
      const { jobId, result } = manager.spawnWithFuture(createSpawnOptions());
      expect(jobId).toMatch(/^bg-/);

      const resolved = await result;
      expect(resolved.summary).toBe('Test result summary');
    });
  });

  describe('usage tracking', () => {
    const usageResult: AgentExecutionResult = {
      agentName: 'test-agent',
      thoroughness: 'medium',
      summary: 'Test result summary',
      parentSessionId: 'test-session',
      resumeId: 'test-resume-id',
      finalAnswer: 'Test answer',
      steps: [],
      completionInfo: {
        totalTokens: 4321,
        totalInputTokens: 4000,
        totalOutputTokens: 321,
        totalCredits: 9,
        iterations: 2,
        toolCalls: 1,
        reachedMaxIterations: false,
      },
    };

    it('records token and credit usage on the completed job', async () => {
      const orchestrator = createMockOrchestrator({ resolveWith: usageResult });
      const manager = new BackgroundAgentManager(orchestrator);

      const jobId = manager.spawn(createSpawnOptions());
      await waitForAllJobsTerminal(manager);

      const job = manager.getJob(jobId);
      expect(job?.status).toBe('completed');
      expect(job?.totalTokens).toBe(4321);
      expect(job?.totalCredits).toBe(9);
    });

    it('leaves usage fields unset on failed jobs', async () => {
      const orchestrator = createMockOrchestrator({ rejectWith: new Error('boom') });
      const manager = new BackgroundAgentManager(orchestrator);

      const jobId = manager.spawn(createSpawnOptions());
      await waitForAllJobsTerminal(manager);

      const job = manager.getJob(jobId);
      expect(job?.status).toBe('failed');
      expect(job?.totalTokens).toBeUndefined();
      expect(job?.totalCredits).toBeUndefined();
    });

    it('includes aggregated usage in the consolidated group notification header', async () => {
      const orchestrator = createMockOrchestrator({ resolveWith: usageResult });
      const manager = new BackgroundAgentManager(orchestrator);

      manager.setCurrentTurn('turn-usage');
      manager.spawn(createSpawnOptions());
      manager.spawn(createSpawnOptions());
      manager.setCurrentTurn(null);
      await waitForAllJobsTerminal(manager);

      const notifications = manager.drainNotifications();
      expect(notifications).toHaveLength(1);
      const headerLine = notifications[0].split('\n')[0];
      expect(headerLine).toContain('8,642 tokens');
      expect(headerLine).toContain('18 credits');
    });
  });

  describe('resume history linkage', () => {
    it('delegates with resumeId set to the job id so history keys to it', async () => {
      const orchestrator = createMockOrchestrator();
      const manager = new BackgroundAgentManager(orchestrator);

      // Pass a bogus resumeId; spawn must override it with the generated job id.
      const jobId = manager.spawn(createSpawnOptions({ resumeId: 'ignored' }));
      await waitForAllJobsTerminal(manager);

      const delegate = vi.mocked(orchestrator.delegateToAgent);
      expect(delegate).toHaveBeenCalledTimes(1);
      expect(delegate.mock.calls[0][0].resumeId).toBe(jobId);
    });
  });
});
