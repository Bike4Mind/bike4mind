import { describe, it, expect } from 'vitest';
import {
  serializeCharter,
  deserializeCharter,
  serializeHandoff,
  deserializeHandoff,
  serializeEpisode,
  deserializeEpisode,
  type SerializedHandoff,
  type SerializedEpisode,
} from '../deepAgentMappers';
import { IDeepAgentCharter } from '../DeepAgentCharterModel';
import { IDeepAgentHandoff } from '../DeepAgentHandoffModel';
import { IDeepAgentEpisode } from '../DeepAgentEpisodeModel';
import { IDriveVector } from '../deepAgentTypes';

const DRIVES: IDriveVector = {
  curiosity: 0.5,
  progress: 0.4,
  social: 0.3,
  novelty: 0.6,
  caution: 0.2,
  aesthetic: 0.1,
};

const INSTANTIATED = new Date('2026-01-01T00:00:00.000Z');
const UPDATED = new Date('2026-06-08T12:00:00.000Z');
const GROOMED = new Date('2026-06-07T09:30:00.000Z');
const AFFIRMED = new Date('2026-06-06T08:00:00.000Z');
const WAKE = new Date('2026-06-08T11:00:00.000Z');

function charterDoc(): IDeepAgentCharter {
  return {
    id: 'mongo-id-1',
    createdAt: INSTANTIATED,
    updatedAt: UPDATED,
    identity: {
      agentId: 'agent-1',
      ownerUserId: 'owner-1',
      name: 'Reproducer',
      role: 'paper-repro',
      instantiatedAt: INSTANTIATED,
      schemaVersion: 1,
    },
    goal: {
      description: 'Reproduce the target paper',
      successCriteria: ['DSF within 5%'],
      deadlineKind: 'soft',
      deadlineAt: UPDATED,
    },
    drives: DRIVES,
    subgoals: [
      {
        id: 's1',
        description: 'read the paper',
        status: 'active',
        priority: 70,
        targetTier: 'engineering-scaled',
        dependsOn: [],
      },
    ],
    semanticMemory: [
      {
        id: 'm1',
        fact: 'KCuF3 is a 1D antiferromagnet',
        evidenceTier: 'external-facing',
        confidence: 0.8,
        sourceEpisodeIds: ['ep-1'],
        lastAffirmedAt: AFFIRMED,
      },
    ],
    currentTier: 'engineering-proxy',
    openQuestions: ['which solver?'],
    blockers: [],
    sizeBudgetBytes: 8192,
    version: 3,
    groomedAt: GROOMED,
  };
}

describe('charter mapper', () => {
  it('serializes every Date field to an ISO string', () => {
    const s = serializeCharter(charterDoc());
    expect(s.identity.instantiatedAt).toBe(INSTANTIATED.toISOString());
    expect(s.goal.deadlineAt).toBe(UPDATED.toISOString());
    expect(s.semanticMemory[0].lastAffirmedAt).toBe(AFFIRMED.toISOString());
    expect(s.groomedAt).toBe(GROOMED.toISOString());
    expect(s.updatedAt).toBe(UPDATED.toISOString());
  });

  it('drops Mongo-only id and createdAt', () => {
    const s = serializeCharter(charterDoc()) as Record<string, unknown>;
    expect(s.id).toBeUndefined();
    expect(s.createdAt).toBeUndefined();
  });

  it('round-trips back to Date on the doc fields a write needs', () => {
    const doc = deserializeCharter(serializeCharter(charterDoc()));
    expect(doc.identity.instantiatedAt).toBeInstanceOf(Date);
    expect(doc.identity.instantiatedAt.toISOString()).toBe(INSTANTIATED.toISOString());
    expect(doc.goal.deadlineAt?.toISOString()).toBe(UPDATED.toISOString());
    expect(doc.semanticMemory[0].lastAffirmedAt).toBeInstanceOf(Date);
    expect(doc.groomedAt?.toISOString()).toBe(GROOMED.toISOString());
    expect(doc.version).toBe(3);
  });

  it('omits optional groomedAt/deadlineAt when absent', () => {
    const doc = charterDoc();
    delete doc.groomedAt;
    delete doc.goal.deadlineAt;
    const s = serializeCharter(doc);
    expect('groomedAt' in s).toBe(false);
    expect('deadlineAt' in s.goal).toBe(false);
  });
});

describe('handoff mapper', () => {
  function handoffDoc(): IDeepAgentHandoff {
    return {
      id: 'mongo-id-2',
      createdAt: INSTANTIATED,
      updatedAt: UPDATED,
      agentId: 'agent-1',
      wakeCount: 5,
      lastWakeAt: WAKE,
      lastActionSummary: 'ran the proxy probe',
      nextIntendedAction: 'scale up',
      nextWakeIntervalMs: 60_000,
      openBlockers: ['waiting on data'],
      lastEpisodeId: 'ep-9',
    };
  }

  it('serializes Date fields and preserves scalars', () => {
    const s = serializeHandoff(handoffDoc());
    expect(s.lastWakeAt).toBe(WAKE.toISOString());
    expect(s.updatedAt).toBe(UPDATED.toISOString());
    expect(s.wakeCount).toBe(5);
    expect(s.nextWakeIntervalMs).toBe(60_000);
  });

  it('round-trips lastWakeAt back to a Date', () => {
    const doc = deserializeHandoff(serializeHandoff(handoffDoc()));
    expect(doc.lastWakeAt).toBeInstanceOf(Date);
    expect(doc.lastWakeAt.toISOString()).toBe(WAKE.toISOString());
    expect(doc.lastEpisodeId).toBe('ep-9');
  });

  it('omits optional fields when absent', () => {
    const doc = handoffDoc();
    delete doc.nextWakeIntervalMs;
    delete doc.lastEpisodeId;
    const s: SerializedHandoff = serializeHandoff(doc);
    expect('nextWakeIntervalMs' in s).toBe(false);
    expect('lastEpisodeId' in s).toBe(false);
  });
});

describe('episode mapper', () => {
  function episodeDoc(): IDeepAgentEpisode {
    return {
      id: 'mongo-id-3',
      createdAt: WAKE,
      updatedAt: WAKE,
      episodeId: 'ep-42',
      agentId: 'agent-1',
      wakeAt: WAKE,
      drivesBefore: DRIVES,
      policyDecision: { actionKind: 'read_paper', rationale: 'curiosity', expectedDriveDelta: {} },
      actionsTaken: [{ tool: 'fetch', input: { url: 'x' }, succeeded: true, durationMs: 10 }],
      observations: [{ kind: 'stdout', summary: 'ok' }],
      reflection: 'learned a thing',
      charterDiff: {
        addedSemanticMemory: [],
        removedSemanticMemoryIds: [],
        subgoalStatusChanges: [],
        summary: 'no change',
      },
      drivesAfter: DRIVES,
      scopeLocks: ['did NOT touch billing'],
      evidenceTier: 'engineering-proxy',
      tokensSpent: 1200,
      costUsd: 0.03,
      reviewedByEpisodeId: 'ep-review-1',
    };
  }

  it('renames episodeId → id on serialize', () => {
    const s: SerializedEpisode = serializeEpisode(episodeDoc());
    expect(s.id).toBe('ep-42');
    expect((s as Record<string, unknown>).episodeId).toBeUndefined();
    expect(s.wakeAt).toBe(WAKE.toISOString());
    expect(s.scopeLocks).toContain('did NOT touch billing');
  });

  it('renames id → episodeId on deserialize and restores the Date', () => {
    const doc = deserializeEpisode(serializeEpisode(episodeDoc()));
    expect(doc.episodeId).toBe('ep-42');
    expect(doc.wakeAt).toBeInstanceOf(Date);
    expect(doc.wakeAt.toISOString()).toBe(WAKE.toISOString());
    expect(doc.reviewedByEpisodeId).toBe('ep-review-1');
    expect(doc.tokensSpent).toBe(1200);
  });

  it('omits optional reviewedByEpisodeId when absent', () => {
    const doc = episodeDoc();
    delete doc.reviewedByEpisodeId;
    const s = serializeEpisode(doc);
    expect('reviewedByEpisodeId' in s).toBe(false);
  });
});
