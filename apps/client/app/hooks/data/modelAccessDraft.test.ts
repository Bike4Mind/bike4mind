import { describe, expect, it } from 'vitest';
import { ModelBackend, type ModelAccessEntry } from '@bike4mind/common';
import {
  committedModelSnapshot,
  modelAccessChanges,
  retainPendingModelEdits,
  type LoadedModelConfiguration,
} from './modelAccessDraft';

const stamp = '2026-11-01T00:00:00.000Z';
const base = (id: string): LoadedModelConfiguration =>
  ({
    id,
    name: id,
    backend: ModelBackend.OpenAI,
    type: 'text',
    contextWindow: 1000,
    max_tokens: 100,
    supportsImageVariation: false,
    pricing: {},
    enabled: true,
    allowedUserTags: [],
    allowedEntitlements: ['base'],
    fallbackModel: '',
    accessEntry: null,
  }) as LoadedModelConfiguration;
const stored = (id: string): LoadedModelConfiguration => {
  const model = base(id);
  return {
    ...model,
    accessEntry: { id, enabled: true, allowedUserTags: [], allowedEntitlements: ['base'], updatedAt: stamp },
  };
};

describe('dashboard conditional Save snapshots', () => {
  it('sends only changed IDs/fields with their actually loaded stamps', () => {
    const loaded = [stored('a'), stored('b')];
    const current = [{ ...loaded[0], enabled: false }, loaded[1]];
    expect(modelAccessChanges(current, loaded)).toEqual([
      { id: 'a', change: { enabled: false }, expectedUpdatedAt: stamp },
    ]);
  });

  it('sends the displayed defaults when creating an absent disabled model entry', () => {
    const loaded = { ...base('a'), enabled: false };
    expect(modelAccessChanges([{ ...loaded, allowedUserTags: ['beta'] }], [loaded])).toEqual([
      {
        id: 'a',
        expectedUpdatedAt: null,
        change: {
          enabled: false,
          allowedUserTags: ['beta'],
          allowedEntitlements: ['base'],
          fallbackModel: null,
          rank: null,
        },
      },
    ]);
  });

  it('serializes fallback and rank removals explicitly, without resending unchanged audiences', () => {
    const loaded = { ...stored('a'), rank: 30, fallbackModel: 'fallback' };
    expect(modelAccessChanges([{ ...loaded, rank: undefined, fallbackModel: '' }], [loaded])).toEqual([
      {
        id: 'a',
        expectedUpdatedAt: stamp,
        change: { rank: null, fallbackModel: null },
      },
    ]);
  });

  it('treats a toggle-back or reordered set as unchanged', () => {
    const loaded = { ...stored('a'), allowedUserTags: ['a', 'b'] };
    expect(modelAccessChanges([{ ...loaded, allowedUserTags: ['b', 'a'] }], [loaded])).toEqual([]);
  });

  it('acknowledges sent fields and stamps while preserving a later in-flight edit', () => {
    const loaded = stored('a');
    const sent = [{ ...loaded, enabled: false }];
    const nextEntry: ModelAccessEntry = {
      ...loaded.accessEntry!,
      enabled: false,
      updatedAt: '2026-11-02T00:00:00.000Z',
    };
    const committed = committedModelSnapshot(sent, {
      entries: [{ id: 'a', entry: nextEntry }],
      changed: 1,
      revision: 'r2',
    });
    const current = [{ ...sent[0], rank: 5 }];
    const retained = retainPendingModelEdits(current, sent, committed);
    expect(retained[0]).toMatchObject({ enabled: false, rank: 5, accessEntry: nextEntry });
    expect(modelAccessChanges(retained, committed)).toEqual([
      { id: 'a', change: { rank: 5 }, expectedUpdatedAt: nextEntry.updatedAt },
    ]);
  });
});
