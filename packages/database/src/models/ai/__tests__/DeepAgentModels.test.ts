import { describe, it, expect, beforeEach } from 'vitest';
import { setupMongoTest } from '../../../__test__/utils';
import DeepAgentCharterModel, { deepAgentCharterRepository, type IDeepAgentCharter } from '../DeepAgentCharterModel';
import DeepAgentHandoffModel, { deepAgentHandoffRepository } from '../DeepAgentHandoffModel';
import DeepAgentEpisodeModel, { deepAgentEpisodeRepository } from '../DeepAgentEpisodeModel';
import { IDriveVector } from '../deepAgentTypes';

const DRIVES: IDriveVector = {
  curiosity: 0.5,
  progress: 0.5,
  social: 0.5,
  novelty: 0.5,
  caution: 0.5,
  aesthetic: 0.5,
};

function charterInput(agentId: string): Omit<IDeepAgentCharter, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    identity: {
      agentId,
      ownerUserId: 'owner-1',
      name: 'Reproducer',
      role: 'paper-repro',
      instantiatedAt: new Date(),
      schemaVersion: 1,
    },
    goal: { description: 'Reproduce the target paper', successCriteria: [], deadlineKind: 'none' },
    drives: DRIVES,
    subgoals: [],
    semanticMemory: [],
    currentTier: 'engineering-proxy',
    openQuestions: [],
    blockers: [],
    sizeBudgetBytes: 8192,
    version: 0,
  };
}

describe('deep agent persistence', () => {
  setupMongoTest();

  // setupMongoTest drops the database in its own beforeEach, which also drops
  // indexes. Re-ensure them here - this beforeEach is registered after
  // setupMongoTest's, so it runs after the drop and before each test.
  beforeEach(async () => {
    await Promise.all([
      DeepAgentCharterModel.ensureIndexes(),
      DeepAgentHandoffModel.ensureIndexes(),
      DeepAgentEpisodeModel.ensureIndexes(),
    ]);
  });

  describe('DeepAgentCharterRepository', () => {
    it('creates and finds a charter by agentId', async () => {
      await deepAgentCharterRepository.create(charterInput('agent-charter-1'));
      const found = await deepAgentCharterRepository.findByAgentId('agent-charter-1');
      expect(found).not.toBeNull();
      expect(found?.identity.role).toBe('paper-repro');
      expect(found?.currentTier).toBe('engineering-proxy');
      expect(found?.id).toBeTruthy();
    });

    it('enforces one charter per agent (unique index)', async () => {
      await deepAgentCharterRepository.create(charterInput('agent-charter-dupe'));
      await expect(deepAgentCharterRepository.create(charterInput('agent-charter-dupe'))).rejects.toThrow();
    });

    it('saveVersioned inserts at v0 and rejects duplicate enrollment', async () => {
      await deepAgentCharterRepository.saveVersioned(charterInput('agent-versioned-1'));
      await expect(deepAgentCharterRepository.saveVersioned(charterInput('agent-versioned-1'))).rejects.toThrow(
        /already enrolled/
      );
    });

    it('saveVersioned advances v0→v1 but rejects a stale concurrent write', async () => {
      await deepAgentCharterRepository.saveVersioned(charterInput('agent-versioned-2'));
      // First wake: v1 write against stored v0 - lands.
      const v1 = await deepAgentCharterRepository.saveVersioned({ ...charterInput('agent-versioned-2'), version: 1 });
      expect(v1.version).toBe(1);
      // A concurrent wake that ALSO read v0 tries to write v1 again - stale.
      await expect(
        deepAgentCharterRepository.saveVersioned({ ...charterInput('agent-versioned-2'), version: 1 })
      ).rejects.toThrow(/stale write/);
      // The next legitimate wake (read v1, write v2) lands.
      const v2 = await deepAgentCharterRepository.saveVersioned({ ...charterInput('agent-versioned-2'), version: 2 });
      expect(v2.version).toBe(2);
    });

    it('setSessionId attaches the mission log write-once', async () => {
      await deepAgentCharterRepository.create(charterInput('agent-session-1'));
      await deepAgentCharterRepository.setSessionId('agent-session-1', 'session-A');
      // a second bridge race cannot re-point the log
      await deepAgentCharterRepository.setSessionId('agent-session-1', 'session-B');
      const doc = await deepAgentCharterRepository.findByAgentId('agent-session-1');
      expect(doc?.sessionId).toBe('session-A');
    });

    it('listByLinkedAgentId returns only the linked missions, newest first', async () => {
      const mk = (agentId: string, linkedAgentId?: string) => ({
        ...charterInput(agentId),
        identity: { ...charterInput(agentId).identity, ...(linkedAgentId ? { linkedAgentId } : {}) },
      });
      await deepAgentCharterRepository.create(mk('mission-1', 'b4m-cerebo'));
      await deepAgentCharterRepository.create(mk('mission-2', 'b4m-cerebo'));
      await deepAgentCharterRepository.create(mk('standalone-1'));
      await deepAgentCharterRepository.create(mk('mission-other', 'b4m-fermi'));

      const missions = await deepAgentCharterRepository.listByLinkedAgentId('b4m-cerebo');
      expect(missions.map(m => m.identity.agentId).sort()).toEqual(['mission-1', 'mission-2']);
      expect(missions.every(m => m.identity.linkedAgentId === 'b4m-cerebo')).toBe(true);
    });

    it('upsertForAgent replaces in place and persists the version', async () => {
      await deepAgentCharterRepository.upsertForAgent(charterInput('agent-charter-2'));
      const bumped = await deepAgentCharterRepository.upsertForAgent({
        ...charterInput('agent-charter-2'),
        version: 7,
      });
      expect(bumped.version).toBe(7);
      const count = await DeepAgentCharterModel.countDocuments({
        'identity.agentId': 'agent-charter-2',
      });
      expect(count).toBe(1);
    });
  });

  describe('DeepAgentHandoffRepository', () => {
    it('upserts and reads the per-agent handoff with defaults applied', async () => {
      const saved = await deepAgentHandoffRepository.upsertForAgent({
        agentId: 'agent-handoff-1',
        wakeCount: 0,
        lastWakeAt: new Date(),
        lastActionSummary: '',
        nextIntendedAction: '',
        openBlockers: [],
      });
      expect(saved.lastActionSummary).toBe('');
      expect(saved.openBlockers).toEqual([]);

      const updated = await deepAgentHandoffRepository.upsertForAgent({
        agentId: 'agent-handoff-1',
        wakeCount: 1,
        lastWakeAt: new Date(),
        lastActionSummary: 'ran the proxy probe',
        nextIntendedAction: 'scale up',
        openBlockers: [],
      });
      expect(updated.wakeCount).toBe(1);

      const count = await DeepAgentHandoffModel.countDocuments({ agentId: 'agent-handoff-1' });
      expect(count).toBe(1);
    });

    it('derives nextWakeAt from lastWakeAt + nextWakeIntervalMs', async () => {
      const lastWakeAt = new Date('2026-06-08T12:00:00.000Z');
      const saved = await deepAgentHandoffRepository.upsertForAgent({
        agentId: 'agent-handoff-sched',
        wakeCount: 1,
        lastWakeAt,
        lastActionSummary: '',
        nextIntendedAction: '',
        nextWakeIntervalMs: 60_000,
        openBlockers: [],
      });
      expect(saved.nextWakeAt?.toISOString()).toBe(new Date(lastWakeAt.getTime() + 60_000).toISOString());
    });

    it('clears nextWakeAt when no interval is set (dormant agent)', async () => {
      const agentId = 'agent-handoff-dormant';
      await deepAgentHandoffRepository.upsertForAgent({
        agentId,
        wakeCount: 1,
        lastWakeAt: new Date(),
        lastActionSummary: '',
        nextIntendedAction: '',
        nextWakeIntervalMs: 60_000,
        openBlockers: [],
      });
      // Re-upsert without an interval - nextWakeAt should be unset.
      const updated = await deepAgentHandoffRepository.upsertForAgent({
        agentId,
        wakeCount: 2,
        lastWakeAt: new Date(),
        lastActionSummary: '',
        nextIntendedAction: '',
        openBlockers: [],
      });
      expect(updated.nextWakeAt == null).toBe(true);
    });

    it('claimDueAgentIds claims atomically — a second scan finds nothing', async () => {
      const now = new Date('2026-06-09T12:00:00.000Z');
      await deepAgentHandoffRepository.upsertForAgent({
        agentId: 'claim-agent',
        wakeCount: 1,
        lastWakeAt: new Date(now.getTime() - 10 * 60_000),
        lastActionSummary: '',
        nextIntendedAction: '',
        nextWakeIntervalMs: 60_000,
        openBlockers: [],
      });

      const first = await deepAgentHandoffRepository.claimDueAgentIds(now, 15 * 60_000);
      expect(first).toEqual(['claim-agent']);
      // Lease pushed nextWakeAt forward - the same tick (or a rival scheduler)
      // claims nothing.
      const second = await deepAgentHandoffRepository.claimDueAgentIds(now, 15 * 60_000);
      expect(second).toEqual([]);
      // But once the lease expires, the agent is reclaimable (crash recovery).
      const afterLease = new Date(now.getTime() + 16 * 60_000);
      const third = await deepAgentHandoffRepository.claimDueAgentIds(afterLease, 15 * 60_000);
      expect(third).toEqual(['claim-agent']);
    });

    it('releaseWakeClaim hands a failed claim back for immediate retry', async () => {
      const now = new Date('2026-06-09T12:00:00.000Z');
      await deepAgentHandoffRepository.upsertForAgent({
        agentId: 'release-agent',
        wakeCount: 1,
        lastWakeAt: new Date(now.getTime() - 10 * 60_000),
        lastActionSummary: '',
        nextIntendedAction: '',
        nextWakeIntervalMs: 60_000,
        openBlockers: [],
      });
      const claimed = await deepAgentHandoffRepository.claimDueAgentIds(now, 15 * 60_000);
      expect(claimed).toEqual(['release-agent']);
      // Enqueue "failed" - hand the claim back; the same tick can reclaim.
      await deepAgentHandoffRepository.releaseWakeClaim('release-agent', now);
      const reclaimed = await deepAgentHandoffRepository.claimDueAgentIds(now, 15 * 60_000);
      expect(reclaimed).toEqual(['release-agent']);
    });

    it('findDueAgentIds returns only agents whose nextWakeAt has passed', async () => {
      const now = new Date('2026-06-08T12:00:00.000Z');
      // Due: woke 10 min ago with a 1-min interval.
      await deepAgentHandoffRepository.upsertForAgent({
        agentId: 'due-agent',
        wakeCount: 1,
        lastWakeAt: new Date(now.getTime() - 10 * 60_000),
        lastActionSummary: '',
        nextIntendedAction: '',
        nextWakeIntervalMs: 60_000,
        openBlockers: [],
      });
      // Not due: woke "now" with a 1-hour interval.
      await deepAgentHandoffRepository.upsertForAgent({
        agentId: 'future-agent',
        wakeCount: 1,
        lastWakeAt: now,
        lastActionSummary: '',
        nextIntendedAction: '',
        nextWakeIntervalMs: 60 * 60_000,
        openBlockers: [],
      });
      // Dormant: no interval -> no nextWakeAt -> never due.
      await deepAgentHandoffRepository.upsertForAgent({
        agentId: 'dormant-agent',
        wakeCount: 1,
        lastWakeAt: new Date(now.getTime() - 10 * 60_000),
        lastActionSummary: '',
        nextIntendedAction: '',
        openBlockers: [],
      });

      const due = await deepAgentHandoffRepository.findDueAgentIds(now);
      expect(due).toContain('due-agent');
      expect(due).not.toContain('future-agent');
      expect(due).not.toContain('dormant-agent');
    });
  });

  describe('DeepAgentEpisodeRepository', () => {
    it('appends episodes and reads the tail newest-first', async () => {
      const base = {
        agentId: 'agent-ep-1',
        drivesBefore: DRIVES,
        policyDecision: { actionKind: 'read_paper', rationale: 'x', expectedDriveDelta: {} },
        actionsTaken: [],
        observations: [],
        reflection: 'did a thing',
        charterDiff: {
          addedSemanticMemory: [],
          removedSemanticMemoryIds: [],
          subgoalStatusChanges: [],
          summary: 'no change',
        },
        drivesAfter: DRIVES,
        scopeLocks: ['did NOT touch billing'],
        evidenceTier: 'engineering-proxy' as const,
        tokensSpent: 0,
        costUsd: 0,
      };
      await deepAgentEpisodeRepository.append({
        ...base,
        episodeId: 'ep-1',
        wakeAt: new Date('2026-06-01T00:00:00.000Z'),
      });
      await deepAgentEpisodeRepository.append({
        ...base,
        episodeId: 'ep-2',
        wakeAt: new Date('2026-06-02T00:00:00.000Z'),
      });

      const recent = await deepAgentEpisodeRepository.findRecentByAgentId('agent-ep-1', 10);
      expect(recent).toHaveLength(2);
      expect(recent[0].episodeId).toBe('ep-2'); // newest first
      expect(recent[0].scopeLocks).toContain('did NOT touch billing');

      const byId = await deepAgentEpisodeRepository.findByEpisodeId('agent-ep-1', 'ep-1');
      expect(byId?.reflection).toBe('did a thing');
    });

    it('rejects a duplicate episodeId for the same agent', async () => {
      const ep = {
        episodeId: 'ep-dupe',
        agentId: 'agent-ep-2',
        wakeAt: new Date(),
        drivesBefore: DRIVES,
        policyDecision: { actionKind: 'a', rationale: 'b', expectedDriveDelta: {} },
        actionsTaken: [],
        observations: [],
        reflection: 'r',
        charterDiff: {
          addedSemanticMemory: [],
          removedSemanticMemoryIds: [],
          subgoalStatusChanges: [],
          summary: 's',
        },
        drivesAfter: DRIVES,
        scopeLocks: [],
        evidenceTier: 'engineering-proxy' as const,
        tokensSpent: 0,
        costUsd: 0,
      };
      await deepAgentEpisodeRepository.append(ep);
      await expect(deepAgentEpisodeRepository.append(ep)).rejects.toThrow();
    });
  });
});
