import { describe, it, expect } from 'vitest';
import type { CitableSource, IChatHistoryItemDocument } from '@bike4mind/common';
import { applyQuestStatusChanges } from './ToolBuilder';
import { areCitablesNumbered, assignCitationIndices, citationNumbersById } from './citationNumbering';

const citable = (id: string, citationIndex?: number): CitableSource =>
  ({
    id,
    type: 'web_url',
    title: id,
    url: `https://example.com/${id}`,
    timestamp: '2026-01-01T00:00:00.000Z',
    status: 'complete',
    ...(citationIndex === undefined ? {} : { metadata: { citationIndex } }),
  }) as CitableSource;

const numbersOf = (citables: readonly CitableSource[] | undefined) => citables?.map(c => c.metadata?.citationIndex);

describe('assignCitationIndices', () => {
  it('continues the forced-retrieval prefix', () => {
    const stamped = assignCitationIndices([citable('f1', 1), citable('f2', 2)], [citable('w1'), citable('w2')]);
    expect(numbersOf(stamped)).toEqual([3, 4]);
  });

  it('starts at 1 on a turn with no citables yet', () => {
    expect(numbersOf(assignCitationIndices([], [citable('w1')]))).toEqual([1]);
  });

  it('gives a source already cited this turn its existing number', () => {
    const stamped = assignCitationIndices([citable('f1', 1), citable('w1', 2)], [citable('w2'), citable('w1')]);
    expect(numbersOf(stamped)).toEqual([3, 2]);
  });

  it('gives a source repeated within one call one number', () => {
    expect(numbersOf(assignCitationIndices([], [citable('w1'), citable('w2'), citable('w1')]))).toEqual([1, 2, 1]);
  });

  it('refuses once a locally numbered tool has broken the sequence', () => {
    expect(assignCitationIndices([citable('f1'), citable('w1')], [citable('w2')])).toBeUndefined();
  });

  it('refuses a citable with no identity, which the merge would drop', () => {
    const keyless = { ...citable('x'), id: '', url: undefined, title: '' } as CitableSource;
    expect(assignCitationIndices([], [citable('w1'), keyless])).toBeUndefined();
  });

  it('does not mutate its inputs', () => {
    const incoming = citable('w1');
    assignCitationIndices([], [incoming]);
    expect(incoming.metadata).toBeUndefined();
  });
});

describe('numbering a turn end to end', () => {
  // What ToolBuilder's numberCitables callback does, followed by the tool's own statusUpdate.
  const numberAndMerge = (quest: IChatHistoryItemDocument, incoming: CitableSource[]) => {
    const stamped = assignCitationIndices(quest.promptMeta?.citables ?? [], incoming);
    if (stamped) applyQuestStatusChanges(quest, { promptMeta: { citables: stamped } } as never, 'user-1');
    applyQuestStatusChanges(quest, { promptMeta: { citables: stamped ?? incoming } } as never, 'user-1');
    return stamped;
  };

  it('keeps forced retrieval and two tool calls on one numbering the client can link', () => {
    const quest = {
      id: 'q1',
      sessionId: 's1',
      promptMeta: { citables: [citable('f1', 1), citable('f2', 2)] },
    } as IChatHistoryItemDocument;
    numberAndMerge(quest, [citable('w1'), citable('w2')]);
    numberAndMerge(quest, [citable('w2'), citable('kb1')]);
    const citables = quest.promptMeta?.citables ?? [];
    expect(citables.map(c => c.id)).toEqual(['f1', 'f2', 'w1', 'w2', 'kb1']);
    expect(areCitablesNumbered(citables)).toBe(true);
  });

  it('turns the links off when a tool that labels its own results merges', () => {
    const quest = {
      id: 'q1',
      sessionId: 's1',
      promptMeta: { citables: [citable('f1', 1)] },
    } as IChatHistoryItemDocument;
    numberAndMerge(quest, [citable('w1')]);
    applyQuestStatusChanges(quest, { promptMeta: { citables: [citable('fetched')] } } as never, 'user-1');
    expect(quest.promptMeta?.citables?.some(c => c.metadata?.citationIndex !== undefined)).toBe(false);
    expect(numberAndMerge(quest, [citable('w2')])).toBeUndefined();
  });
});

describe('citationNumbersById', () => {
  it('maps each stamped citable id to its number and skips unstamped ones', () => {
    expect([...citationNumbersById([citable('a', 3), citable('b')])]).toEqual([['a', 3]]);
  });
});
