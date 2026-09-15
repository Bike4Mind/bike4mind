import { describe, it, expect, vi } from 'vitest';
import type { Charter } from '@bike4mind/agents';
import { enrollDeepAgent, type EnrollDeepAgentInput } from './enroll';

const T0 = Date.parse('2026-06-08T12:00:00.000Z');

function deps(
  overrides: { saveCharter?: (c: Charter) => Promise<Charter>; enqueueWake?: (id: string) => Promise<void> } = {}
) {
  const saved: Charter[] = [];
  const enqueued: string[] = [];
  return {
    saved,
    enqueued,
    d: {
      store: {
        saveCharter:
          overrides.saveCharter ??
          (async (c: Charter) => {
            saved.push(c);
            return c;
          }),
      },
      enqueueWake:
        overrides.enqueueWake ??
        (async (id: string) => {
          enqueued.push(id);
        }),
      newAgentId: () => 'agent-fixed',
      now: () => T0,
    },
  };
}

const baseInput: EnrollDeepAgentInput = {
  ownerUserId: 'owner-1',
  name: 'Reproducer',
  role: 'paper-repro',
  goal: { description: 'Reproduce the target paper' },
};

describe('enrollDeepAgent', () => {
  it('builds a valid charter with the owner, defaults, and goal, then saves + enqueues', async () => {
    const { d, saved, enqueued } = deps();
    const result = await enrollDeepAgent(baseInput, d);

    expect(result.agentId).toBe('agent-fixed');
    expect(result.charter.identity.ownerUserId).toBe('owner-1');
    expect(result.charter.identity.role).toBe('paper-repro');
    expect(result.charter.identity.instantiatedAt).toBe(new Date(T0).toISOString());
    expect(result.charter.currentTier).toBe('engineering-proxy'); // default
    expect(result.charter.drives.curiosity).toBe(0.5); // DEFAULT_DRIVES
    expect(result.charter.sizeBudgetBytes).toBe(8 * 1024); // schema default
    expect(result.charter.version).toBe(0);

    expect(saved).toHaveLength(1);
    expect(enqueued).toEqual(['agent-fixed']); // first wake enqueued
  });

  it('applies drive overrides, tier, and budget', async () => {
    const { d } = deps();
    const result = await enrollDeepAgent(
      {
        ...baseInput,
        currentTier: 'external-facing',
        drives: { curiosity: 0.9 },
        sizeBudgetBytes: 16_384,
        goal: { description: 'reproduce', successCriteria: ['DSF within 5%'], deadlineKind: 'soft' },
      },
      d
    );
    expect(result.charter.currentTier).toBe('external-facing');
    expect(result.charter.drives.curiosity).toBe(0.9);
    expect(result.charter.drives.progress).toBe(0.5); // untouched default
    expect(result.charter.sizeBudgetBytes).toBe(16_384);
    expect(result.charter.goal.successCriteria).toEqual(['DSF within 5%']);
    expect(result.charter.goal.deadlineKind).toBe('soft');
  });

  it('passes mission linkage through to the charter identity', async () => {
    const { d } = deps();
    const result = await enrollDeepAgent({ ...baseInput, linkedAgentId: 'b4m-agent-cerebo' }, d);
    expect(result.charter.identity.linkedAgentId).toBe('b4m-agent-cerebo');
    const standalone = await enrollDeepAgent(baseInput, d);
    expect(standalone.charter.identity.linkedAgentId).toBeUndefined();
  });

  it('rejects a malformed enrollment (empty name) before saving', async () => {
    const { d, saved, enqueued } = deps();
    await expect(enrollDeepAgent({ ...baseInput, name: '' }, d)).rejects.toThrow();
    expect(saved).toHaveLength(0);
    expect(enqueued).toHaveLength(0);
  });

  it('does not enqueue if the charter fails to save', async () => {
    const enqueueWake = vi.fn(async () => {});
    const { d } = deps({
      saveCharter: async () => {
        throw new Error('db down');
      },
      enqueueWake,
    });
    await expect(enrollDeepAgent(baseInput, d)).rejects.toThrow('db down');
    expect(enqueueWake).not.toHaveBeenCalled();
  });
});
