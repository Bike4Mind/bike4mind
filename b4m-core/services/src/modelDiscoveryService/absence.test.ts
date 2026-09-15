import { ModelBackend } from '@bike4mind/common';
import type { ResolvedCatalogRecord } from '@bike4mind/llm-adapters';
import { describe, expect, it, vi } from 'vitest';
import { applyAbsence, planAbsence } from './absence';

const known = (modelId: string, backend: ModelBackend): [string, ResolvedCatalogRecord] => [
  modelId,
  { modelId, record: { id: modelId, backend }, ownedGroups: ['identity'] },
];

const base = new Map([
  known('gpt-6', ModelBackend.OpenAI),
  known('gpt-5', ModelBackend.OpenAI),
  known('claude-opus-5', ModelBackend.Anthropic),
]);

describe('planAbsence', () => {
  it('records a sighting for every model a successful source listed', () => {
    const plan = planAbsence({
      coveredBackends: new Set([ModelBackend.OpenAI]),
      sightedModelIds: new Set(['gpt-6', 'gpt-5']),
      base,
    });

    expect(plan.sighted).toEqual(['gpt-5', 'gpt-6']);
    expect(plan.missed).toEqual([]);
  });

  it('counts a miss only for a backend a successful source is authoritative for', () => {
    const plan = planAbsence({
      coveredBackends: new Set([ModelBackend.OpenAI]),
      sightedModelIds: new Set(['gpt-6']),
      base,
    });

    expect(plan.missed).toEqual(['gpt-5']);
    // Anthropic was never listed this run, so its models are frozen, not missing.
    expect(plan.frozenBackends).toEqual([ModelBackend.Anthropic]);
  });

  it('freezes every counter when no source succeeded', () => {
    const plan = planAbsence({ coveredBackends: new Set(), sightedModelIds: new Set(), base });

    expect(plan.missed).toEqual([]);
    expect(plan.sighted).toEqual([]);
    expect(plan.frozenBackends).toEqual([ModelBackend.Anthropic, ModelBackend.OpenAI]);
  });

  it('sights a model the catalog has never held', () => {
    const plan = planAbsence({
      coveredBackends: new Set([ModelBackend.OpenAI]),
      sightedModelIds: new Set(['gpt-6', 'gpt-5', 'gpt-7']),
      base,
    });

    expect(plan.sighted).toContain('gpt-7');
  });
});

describe('applyAbsence', () => {
  it('resets the sighted models and extends the missed ones', async () => {
    const repository = { recordSighting: vi.fn(), recordMiss: vi.fn() };
    const at = new Date('2026-07-26T10:00:00Z');

    await applyAbsence({ sighted: ['gpt-6'], missed: ['gpt-5'], frozenBackends: [] }, repository, at);

    expect(repository.recordSighting).toHaveBeenCalledWith('gpt-6', at);
    expect(repository.recordMiss).toHaveBeenCalledWith('gpt-5', at);
  });
});
