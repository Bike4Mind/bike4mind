import { describe, expect, it } from 'vitest';
import { ModelBackend } from '@bike4mind/common';
import type { ResolvedCatalogRecord } from '@bike4mind/llm-adapters';
import { modelListChanges } from './modelListImpact';

const resolved = (modelId: string, record: Record<string, unknown>): ResolvedCatalogRecord => ({
  modelId,
  record: { id: modelId, backend: ModelBackend.Anthropic, ...record },
  ownedGroups: [],
});

const withStatus = (modelId: string, status: string | undefined, extra: Record<string, unknown> = {}) =>
  resolved(modelId, { ...(status === undefined ? {} : { lifecycle: { status } }), ...extra });

const recordsOf = (...records: ResolvedCatalogRecord[]) => new Map(records.map(r => [r.modelId, r] as const));

const NONE = new Set<string>();

describe('modelListChanges', () => {
  it('reports nothing when nothing was written', () => {
    expect(
      modelListChanges({
        writtenModelIds: [],
        staticModelIds: new Set(['gpt-x']),
        before: recordsOf(withStatus('gpt-x', 'active')),
        after: recordsOf(withStatus('gpt-x', 'active')),
      })
    ).toEqual([]);
  });

  it('ignores a new model that lands discovered and unpromoted', () => {
    expect(
      modelListChanges({
        writtenModelIds: ['new-model'],
        staticModelIds: NONE,
        before: new Map(),
        after: recordsOf(withStatus('new-model', 'discovered', { autoDisabled: true })),
      })
    ).toEqual([]);
  });

  it('ignores a reprice or update of a model that stays discovered or unlisted', () => {
    expect(
      modelListChanges({
        writtenModelIds: ['still-discovered', 'still-unlisted'],
        staticModelIds: NONE,
        before: recordsOf(withStatus('still-discovered', 'discovered'), withStatus('still-unlisted', 'unlisted')),
        after: recordsOf(
          withStatus('still-discovered', 'discovered', { contextWindow: 200_000 }),
          withStatus('still-unlisted', 'unlisted')
        ),
      })
    ).toEqual([]);
  });

  it('reports a promotion out of discovered', () => {
    expect(
      modelListChanges({
        writtenModelIds: ['claude-fable-5-2'],
        staticModelIds: NONE,
        before: new Map(),
        after: recordsOf(withStatus('claude-fable-5-2', 'active')),
      })
    ).toEqual(['claude-fable-5-2']);
  });

  it('reports a reprice of a listed catalog model', () => {
    const listed = withStatus('listed', 'active');
    expect(
      modelListChanges({
        writtenModelIds: ['listed'],
        staticModelIds: NONE,
        before: recordsOf(listed),
        after: recordsOf(listed),
      })
    ).toEqual(['listed']);
  });

  it('reports a model leaving the list', () => {
    expect(
      modelListChanges({
        writtenModelIds: ['leaving'],
        staticModelIds: NONE,
        before: recordsOf(withStatus('leaving', 'active')),
        after: recordsOf(withStatus('leaving', 'deprecated', { replacedBy: 'successor' })),
      })
    ).toEqual(['leaving']);
  });

  it('reports a sunset model, whose successor can surface as a superseded-pin upgrade', () => {
    expect(
      modelListChanges({
        writtenModelIds: ['sunset'],
        staticModelIds: NONE,
        before: recordsOf(withStatus('sunset', 'retired')),
        after: recordsOf(withStatus('sunset', 'retired', { replacedBy: 'successor' })),
      })
    ).toEqual(['sunset']);
  });

  it('reports any write to a model the adapter tables list, whatever its catalog status', () => {
    expect(
      modelListChanges({
        writtenModelIds: ['seeded'],
        staticModelIds: new Set(['seeded']),
        before: recordsOf(withStatus('seeded', 'discovered')),
        after: recordsOf(withStatus('seeded', 'discovered')),
      })
    ).toEqual(['seeded']);
  });

  it('reports a write to a runtime-listed backend, which the live listing seeds', () => {
    const local = withStatus('llama3:8b', 'discovered', { backend: ModelBackend.Ollama });
    expect(
      modelListChanges({
        writtenModelIds: ['llama3:8b'],
        staticModelIds: NONE,
        before: recordsOf(local),
        after: recordsOf(local),
      })
    ).toEqual(['llama3:8b']);
  });

  it('counts a status outside the off-list allowlist, such as legacy, as listed', () => {
    expect(
      modelListChanges({
        writtenModelIds: ['legacy'],
        staticModelIds: NONE,
        before: recordsOf(withStatus('legacy', 'legacy')),
        after: recordsOf(withStatus('legacy', 'legacy')),
      })
    ).toEqual(['legacy']);
  });

  it('reports only the written models that can move a list, once each', () => {
    expect(
      modelListChanges({
        writtenModelIds: ['quiet', 'promoted', 'promoted'],
        staticModelIds: NONE,
        before: recordsOf(withStatus('quiet', 'discovered'), withStatus('promoted', 'discovered')),
        after: recordsOf(withStatus('quiet', 'discovered'), withStatus('promoted', 'active')),
      })
    ).toEqual(['promoted']);
  });
});
