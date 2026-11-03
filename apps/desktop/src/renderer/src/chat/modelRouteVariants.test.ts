import type { ChatModelOption } from '@shared/chat';
import { describe, expect, it } from 'vitest';
import { sortByRecency } from './ModelPicker';
import { matchesFilters, matchesQuery, NO_FILTERS } from './modelPickerFilters';
import { mergeRouteVariants, routeVariantKey } from './modelRouteVariants';

/** The order the server listed them in, with the dates only some routes carry. */
const FABLE: ChatModelOption[] = [
  { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', backend: 'anthropic', releaseDate: '2026-10-01' },
  { id: 'anthropic.claude-fable-5-1', name: 'Claude Fable 5.1', backend: 'bedrock', releaseDate: '2026-10-01' },
  { id: 'claude-fable-5', name: 'Claude Fable 5', backend: 'anthropic', releaseDate: '2026-06-01' },
  { id: 'anthropic.claude-fable-5', name: 'Claude Fable 5', backend: 'bedrock', releaseDate: '2026-06-01' },
  { id: 'global.anthropic.claude-fable-5', name: 'Claude Fable 5', backend: 'bedrock' },
  { id: 'global.anthropic.claude-fable-5-1', name: 'Claude Fable 5.1', backend: 'bedrock' },
];

const ids = (models: readonly ChatModelOption[]) => models.map(model => model.id);

describe('routeVariantKey', () => {
  it('joins a Bedrock foundation id with its inference profiles, and nothing else', () => {
    expect(routeVariantKey({ id: 'anthropic.claude-fable-5', backend: 'bedrock' })).toBe(
      routeVariantKey({ id: 'global.anthropic.claude-fable-5', backend: 'bedrock' })
    );
    expect(routeVariantKey({ id: 'us.anthropic.claude-fable-5', backend: 'bedrock' })).toBe(
      routeVariantKey({ id: 'apac.anthropic.claude-fable-5', backend: 'bedrock' })
    );
    expect(routeVariantKey({ id: 'anthropic.claude-fable-5', backend: 'bedrock' })).not.toBe(
      routeVariantKey({ id: 'anthropic.claude-fable-5-1', backend: 'bedrock' })
    );
    expect(routeVariantKey({ id: 'global.claude-x', backend: 'anthropic' })).not.toBe(
      routeVariantKey({ id: 'claude-x', backend: 'anthropic' })
    );
  });
});

describe('mergeRouteVariants', () => {
  it('lists each model once per provider, preferring the global profile, in incoming order', () => {
    expect(ids(mergeRouteVariants(FABLE, null))).toEqual([
      'claude-fable-5-1',
      'claude-fable-5',
      'global.anthropic.claude-fable-5',
      'global.anthropic.claude-fable-5-1',
    ]);
  });

  it("keeps the conversation's own variant as its model's row, even a hidden one", () => {
    expect(ids(mergeRouteVariants(FABLE, 'anthropic.claude-fable-5-1'))).toEqual([
      'claude-fable-5-1',
      'anthropic.claude-fable-5-1',
      'claude-fable-5',
      'global.anthropic.claude-fable-5',
    ]);
  });

  it('prefers an enabled variant over a disabled or unavailable one', () => {
    const disabledGlobal = FABLE.map(model => (model.id.startsWith('global.') ? { ...model, disabled: true } : model));
    expect(ids(mergeRouteVariants(disabledGlobal, null))).toEqual([
      'claude-fable-5-1',
      'anthropic.claude-fable-5-1',
      'claude-fable-5',
      'anthropic.claude-fable-5',
    ]);
    const unavailableGlobal = FABLE.map(model =>
      model.id.startsWith('global.') ? { ...model, unavailable: 'not now' } : model
    );
    expect(ids(mergeRouteVariants(unavailableGlobal, null))).toEqual(ids(mergeRouteVariants(disabledGlobal, null)));
  });

  it('ranks global, then a geography, then the bare id, then the lower id, whatever the input order', () => {
    const variant = (id: string): ChatModelOption => ({ id, name: 'Claude Opus 5', backend: 'bedrock' });
    const all = ['anthropic.claude-opus-5', 'us.anthropic.claude-opus-5', 'eu.anthropic.claude-opus-5'].map(variant);
    expect(ids(mergeRouteVariants(all, null))).toEqual(['eu.anthropic.claude-opus-5']);
    expect(ids(mergeRouteVariants([...all].reverse(), null))).toEqual(['eu.anthropic.claude-opus-5']);
    expect(ids(mergeRouteVariants([...all, variant('global.anthropic.claude-opus-5')], null))).toEqual([
      'global.anthropic.claude-opus-5',
    ]);
    expect(ids(mergeRouteVariants([variant('anthropic.claude-opus-5')], null))).toEqual(['anthropic.claude-opus-5']);
  });

  it('leaves other providers, snapshots and local models as they are', () => {
    const others: ChatModelOption[] = [
      { id: 'gpt-4.1-2025-04-14', name: 'GPT-4.1', backend: 'openai' },
      { id: 'gpt-4.1', name: 'GPT-4.1', backend: 'openai' },
      { id: 'local:ollama:us.qwen', name: 'us.qwen', backend: 'local-ollama' },
      { id: 'local:ollama:qwen', name: 'qwen', backend: 'local-ollama' },
    ];
    expect(mergeRouteVariants(others, null)).toEqual(others);
  });
});

describe('merged rows', () => {
  const rows = mergeRouteVariants(FABLE, null);

  it('order newest model first, its providers together, though only one route carries a date', () => {
    expect(ids(sortByRecency(rows))).toEqual([
      'claude-fable-5-1',
      'global.anthropic.claude-fable-5-1',
      'claude-fable-5',
      'global.anthropic.claude-fable-5',
    ]);
  });

  it('answer the provider filter and a typed query like any other row', () => {
    expect(ids(rows.filter(model => matchesFilters(model, { ...NO_FILTERS, provider: 'bedrock' })))).toEqual([
      'global.anthropic.claude-fable-5',
      'global.anthropic.claude-fable-5-1',
    ]);
    expect(ids(rows.filter(model => matchesQuery(model, 'fable 5.1', model.backend)))).toEqual([
      'claude-fable-5-1',
      'global.anthropic.claude-fable-5-1',
    ]);
    expect(ids(rows.filter(model => matchesQuery(model, 'fable bedrock', model.backend)))).toEqual([
      'global.anthropic.claude-fable-5',
      'global.anthropic.claude-fable-5-1',
    ]);
    expect(ids(rows.filter(model => matchesQuery(model, 'fable', model.backend)))).toHaveLength(4);
  });
});
