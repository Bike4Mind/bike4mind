import { describe, it, expect } from 'vitest';
import {
  CharterSchema,
  DEFAULT_CHARTER_SIZE_BUDGET_BYTES,
  SemanticMemoryEntrySchema,
  SubgoalSchema,
  isCharterOverBudget,
  measureCharterSizeBytes,
  type Charter,
} from './charter';
import { DEFAULT_DRIVES } from './drives';

const ISO = '2026-06-08T00:00:00.000Z';

/** Minimal input that satisfies every required Charter field. */
function minimalCharterInput() {
  return {
    identity: {
      agentId: 'agent-1',
      ownerUserId: 'owner-1',
      name: 'Reproducer',
      role: 'paper-repro',
      instantiatedAt: ISO,
      schemaVersion: 1 as const,
    },
    goal: { description: 'Reproduce the target paper' },
    drives: DEFAULT_DRIVES,
    updatedAt: ISO,
  };
}

describe('CharterSchema defaults', () => {
  it('applies the documented defaults from a minimal input', () => {
    const charter = CharterSchema.parse(minimalCharterInput());
    expect(charter.subgoals).toEqual([]);
    expect(charter.semanticMemory).toEqual([]);
    expect(charter.currentTier).toBe('engineering-proxy');
    expect(charter.openQuestions).toEqual([]);
    expect(charter.blockers).toEqual([]);
    expect(charter.sizeBudgetBytes).toBe(DEFAULT_CHARTER_SIZE_BUDGET_BYTES);
    expect(charter.version).toBe(0);
    expect(charter.groomedAt).toBeUndefined();
  });

  it("rejects deadlineAt when deadlineKind is 'none' (internally consistent goals only)", () => {
    const bad = { ...minimalCharterInput(), goal: { description: 'g', deadlineAt: ISO } };
    expect(CharterSchema.safeParse(bad).success).toBe(false);
    const good = { ...minimalCharterInput(), goal: { description: 'g', deadlineKind: 'soft', deadlineAt: ISO } };
    expect(CharterSchema.safeParse(good).success).toBe(true);
  });

  it('accepts an optional mission linkage (linkedAgentId)', () => {
    const linked = {
      ...minimalCharterInput(),
      identity: { ...minimalCharterInput().identity, linkedAgentId: 'b4m-agent-cerebo' },
    };
    const parsed = CharterSchema.parse(linked);
    expect(parsed.identity.linkedAgentId).toBe('b4m-agent-cerebo');
    // and remains absent for standalone deep agents
    expect(CharterSchema.parse(minimalCharterInput()).identity.linkedAgentId).toBeUndefined();
  });

  it('accepts an optional mission-log sessionId', () => {
    const withLog = CharterSchema.parse({ ...minimalCharterInput(), sessionId: 'session-42' });
    expect(withLog.sessionId).toBe('session-42');
    expect(CharterSchema.parse(minimalCharterInput()).sessionId).toBeUndefined();
  });

  it('defaults the goal sub-fields', () => {
    const charter = CharterSchema.parse(minimalCharterInput());
    expect(charter.goal.successCriteria).toEqual([]);
    expect(charter.goal.deadlineKind).toBe('none');
  });
});

describe('CharterSchema validation', () => {
  it('pins schemaVersion to the literal 1', () => {
    const bad = minimalCharterInput();
    // @ts-expect-error - exercising runtime rejection of a wrong version
    bad.identity.schemaVersion = 2;
    expect(CharterSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a non-datetime instantiatedAt', () => {
    const bad = minimalCharterInput();
    bad.identity.instantiatedAt = 'last tuesday';
    expect(CharterSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an empty agentId', () => {
    const bad = minimalCharterInput();
    bad.identity.agentId = '';
    expect(CharterSchema.safeParse(bad).success).toBe(false);
  });

  it('requires a drive vector', () => {
    const bad = minimalCharterInput() as Record<string, unknown>;
    delete bad.drives;
    expect(CharterSchema.safeParse(bad).success).toBe(false);
  });
});

describe('SubgoalSchema defaults', () => {
  it('defaults status, priority, targetTier, and dependsOn', () => {
    const subgoal = SubgoalSchema.parse({ id: 's1', description: 'do a thing' });
    expect(subgoal.status).toBe('planned');
    expect(subgoal.priority).toBe(50);
    expect(subgoal.targetTier).toBe('engineering-scaled');
    expect(subgoal.dependsOn).toEqual([]);
  });

  it('rejects a priority outside [0, 100]', () => {
    expect(SubgoalSchema.safeParse({ id: 's', description: 'd', priority: 101 }).success).toBe(false);
    expect(SubgoalSchema.safeParse({ id: 's', description: 'd', priority: -1 }).success).toBe(false);
  });
});

describe('SemanticMemoryEntrySchema', () => {
  it('defaults confidence to 0.5 and sourceEpisodeIds to []', () => {
    const entry = SemanticMemoryEntrySchema.parse({
      id: 'm1',
      fact: 'KCuF3 is a 1D antiferromagnet',
      evidenceTier: 'engineering-proxy',
      lastAffirmedAt: ISO,
    });
    expect(entry.confidence).toBe(0.5);
    expect(entry.sourceEpisodeIds).toEqual([]);
  });

  it('rejects a confidence outside [0, 1]', () => {
    const base = { id: 'm1', fact: 'f', evidenceTier: 'engineering-proxy', lastAffirmedAt: ISO };
    expect(SemanticMemoryEntrySchema.safeParse({ ...base, confidence: 1.5 }).success).toBe(false);
    expect(SemanticMemoryEntrySchema.safeParse({ ...base, confidence: -0.1 }).success).toBe(false);
  });
});

describe('charter size budget', () => {
  it('measures the serialized JSON byte length', () => {
    const charter = CharterSchema.parse(minimalCharterInput());
    expect(measureCharterSizeBytes(charter)).toBe(Buffer.byteLength(JSON.stringify(charter), 'utf8'));
  });

  it('a fresh minimal charter is well under the 8KB budget', () => {
    const charter = CharterSchema.parse(minimalCharterInput());
    expect(measureCharterSizeBytes(charter)).toBeLessThan(DEFAULT_CHARTER_SIZE_BUDGET_BYTES);
    expect(isCharterOverBudget(charter)).toBe(false);
  });

  it('flags a charter whose content exceeds its budget', () => {
    // A tiny fixed budget any real charter blows past - grooming should fire.
    // (Deriving the budget from the measured size is circular: shrinking
    // sizeBudgetBytes also shrinks the serialized JSON.)
    const charter: Charter = CharterSchema.parse({
      ...minimalCharterInput(),
      sizeBudgetBytes: 50,
    });
    expect(measureCharterSizeBytes(charter)).toBeGreaterThan(50);
    expect(isCharterOverBudget(charter)).toBe(true);
  });

  it('the default budget is 8KB', () => {
    expect(DEFAULT_CHARTER_SIZE_BUDGET_BYTES).toBe(8 * 1024);
  });
});
