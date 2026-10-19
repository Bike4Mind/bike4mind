import { describe, it, expect } from 'vitest';
import type { CitableSource, IChatHistoryItemDocument } from '@bike4mind/common';
import { applyQuestStatusChanges, registerQuestCitables } from './ToolBuilder';

// Minimal quest factory - only the fields applyQuestStatusChanges touches matter.
function makeQuest(overrides: Partial<IChatHistoryItemDocument> = {}): IChatHistoryItemDocument {
  return { id: 'q1', sessionId: 's1', ...overrides } as IChatHistoryItemDocument;
}

describe('registerQuestCitables', () => {
  const source = (id: string): CitableSource => ({ id, type: 'web_url', title: id, url: `https://example.com/${id}` });

  it('deduplicates the first batch when the quest has no prompt metadata', () => {
    const quest = makeQuest();
    expect(
      registerQuestCitables(quest, [source('a'), source('a')], 'user-1').map(c => c.metadata?.citationIndex)
    ).toEqual([1, 1]);
    expect(
      registerQuestCitables(quest, [source('b'), source('a')], 'user-1').map(c => c.metadata?.citationIndex)
    ).toEqual([2, 1]);
    expect(quest.promptMeta?.citables?.map(c => [c.id, c.metadata?.citationIndex])).toEqual([
      ['a', 1],
      ['b', 2],
    ]);
  });

  it('reserves numbers before async status updates and reuses overlapping sources', async () => {
    const quest = makeQuest({ promptMeta: { citables: [{ ...source('forced'), metadata: { citationIndex: 1 } }] } });
    const first = registerQuestCitables(quest, [source('a'), source('a')], 'user-1');
    const second = registerQuestCitables(quest, [source('b'), source('a')], 'user-1');
    expect(first.map(c => c.metadata?.citationIndex)).toEqual([2, 2]);
    expect(second.map(c => c.metadata?.citationIndex)).toEqual([3, 2]);
    // Status delivery can finish in the opposite order to number reservation.
    await Promise.all([
      Promise.resolve().then(() => applyQuestStatusChanges(quest, { promptMeta: { citables: second } }, 'user-1')),
      Promise.resolve().then(() => applyQuestStatusChanges(quest, { promptMeta: { citables: first } }, 'user-1')),
    ]);
    expect(quest.promptMeta?.citables?.map(c => [c.id, c.metadata?.citationIndex])).toEqual([
      ['forced', 1],
      ['a', 2],
      ['b', 3],
    ]);
  });

  it('keeps a reserved number when a passage anchor replaces a file chip', () => {
    const quest = makeQuest();
    registerQuestCitables(quest, [source('a')], 'user-1');
    const anchored = { ...source('a'), metadata: { fullContext: 'Selected passage', conflictsWith: ['other'] } };
    registerQuestCitables(quest, [anchored], 'user-1');
    expect(quest.promptMeta?.citables).toEqual([{ ...anchored, metadata: { ...anchored.metadata, citationIndex: 1 } }]);
    expect(anchored.metadata).not.toHaveProperty('citationIndex');
  });

  it('scopes numbering to the quest and uses URL or title when id is absent', () => {
    const first = makeQuest();
    const second = makeQuest();
    const urlOnly: CitableSource = { id: '', type: 'web_url', title: 'Page', url: 'https://example.com' };
    const titleOnly: CitableSource = { id: '', type: 'document', title: 'Document' };
    expect(
      registerQuestCitables(first, [urlOnly, titleOnly, urlOnly], 'user-1').map(c => c.metadata?.citationIndex)
    ).toEqual([1, 2, 1]);
    expect(registerQuestCitables(second, [source('b')], 'user-1')[0].metadata?.citationIndex).toBe(1);
  });

  it('leaves an identity-less source unstamped rather than failing the tool call', () => {
    const quest = makeQuest();
    const keyless: CitableSource = { id: '', type: 'document', title: '' };

    expect(registerQuestCitables(quest, [keyless], 'user-1')).toEqual([keyless]);
    expect(quest.promptMeta?.citables ?? []).toEqual([]);
    // It reserved nothing, so the next real source still starts at 1.
    expect(registerQuestCitables(quest, [source('a')], 'user-1')[0].metadata?.citationIndex).toBe(1);
  });

  it('returns sources unstamped once an existing entry no longer holds its position number', () => {
    const quest = makeQuest({
      promptMeta: { citables: [{ ...source('forced'), metadata: { citationIndex: 7 } }] },
    });

    const registered = registerQuestCitables(quest, [source('a')], 'user-1');

    expect(registered[0].metadata?.citationIndex).toBeUndefined();
    expect(quest.promptMeta?.citables?.[0].metadata?.citationIndex).toBe(7);
  });
});

describe('applyQuestStatusChanges', () => {
  describe('generationJobs', () => {
    const video = (id: string) => ({ id, kind: 'video' as const });
    const music = (id: string) => ({ id, kind: 'music' as const });

    it('keeps both jobs when two sequential updates each carry one job', () => {
      const quest = makeQuest();
      applyQuestStatusChanges(quest, { generationJobs: [video('job-a')] }, 'user-1');
      applyQuestStatusChanges(quest, { generationJobs: [music('job-b')] }, 'user-1');
      expect(quest.generationJobs).toEqual([video('job-a'), music('job-b')]);
    });

    it('dedupes already-present jobs by id and keeps order', () => {
      const quest = makeQuest({ generationJobs: [music('a')] });
      applyQuestStatusChanges(quest, { generationJobs: [music('a'), video('b')] }, 'user-1');
      expect(quest.generationJobs).toEqual([music('a'), video('b')]);
    });

    it('initializes the field when the quest has none', () => {
      const quest = makeQuest();
      applyQuestStatusChanges(quest, { generationJobs: [music('b')] }, 'user-1');
      expect(quest.generationJobs).toEqual([music('b')]);
    });
  });

  describe('images (multi-image-generation persistence bug)', () => {
    it('appends images across multiple calls instead of overwriting', () => {
      // Repro of the prod bug: 4 separate image_generation tool calls, each
      // sending only its own image through statusUpdate. Wholesale overwrite
      // collapsed this to "Image 1 of 1"; merge-append must keep all four.
      const quest = makeQuest();
      applyQuestStatusChanges(quest, { images: ['a.jpg'] }, 'user-1');
      applyQuestStatusChanges(quest, { images: ['b.jpg'] }, 'user-1');
      applyQuestStatusChanges(quest, { images: ['c.jpg'] }, 'user-1');
      applyQuestStatusChanges(quest, { images: ['d.jpg'] }, 'user-1');
      expect(quest.images).toEqual(['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg']);
    });

    it('appends a multi-image batch from a single call', () => {
      const quest = makeQuest({ images: ['a.jpg'] });
      applyQuestStatusChanges(quest, { images: ['b.jpg', 'c.jpg'] }, 'user-1');
      expect(quest.images).toEqual(['a.jpg', 'b.jpg', 'c.jpg']);
    });

    it('dedupes already-present paths (idempotent with onToolFinish append)', () => {
      const quest = makeQuest({ images: ['a.jpg'] });
      applyQuestStatusChanges(quest, { images: ['a.jpg'] }, 'user-1');
      expect(quest.images).toEqual(['a.jpg']);
    });

    it('initializes images when the quest has none', () => {
      const quest = makeQuest();
      applyQuestStatusChanges(quest, { images: ['a.jpg'] }, 'user-1');
      expect(quest.images).toEqual(['a.jpg']);
    });

    it('leaves images untouched when the change set has none', () => {
      const quest = makeQuest({ images: ['a.jpg'] });
      applyQuestStatusChanges(quest, { reply: 'hi' } as Partial<IChatHistoryItemDocument>, 'user-1');
      expect(quest.images).toEqual(['a.jpg']);
    });
  });

  describe('promptMeta.citables', () => {
    const stamped = (id: string, citationIndex: number) => ({
      id,
      url: `u-${id}`,
      title: id,
      metadata: { citationIndex },
    });

    it('strips forced-retrieval citation stamps when a tool merges duplicate-only citables', () => {
      const quest = makeQuest({ promptMeta: { citables: [stamped('f1', 1), stamped('f2', 2)] } });
      applyQuestStatusChanges(quest, { promptMeta: { citables: [{ id: 'f1', url: 'u-f1', title: 'f1' }] } }, 'user-1');
      const citables = quest.promptMeta?.citables ?? [];
      expect(citables.map(c => c.id)).toEqual(['f1', 'f2']);
      expect(citables.every(c => c.metadata?.citationIndex === undefined)).toBe(true);
    });

    it('keeps citation stamps when the merge carries no tool citables', () => {
      const quest = makeQuest({ promptMeta: { citables: [stamped('f1', 1), stamped('f2', 2)] } });
      applyQuestStatusChanges(quest, { promptMeta: { warnings: ['w'] } }, 'user-1');
      expect(quest.promptMeta?.citables?.map(c => c.metadata?.citationIndex)).toEqual([1, 2]);
    });

    it('strips every stamp when an incoming batch mixes stamped and unstamped sources', () => {
      const quest = makeQuest({ promptMeta: { citables: [stamped('f1', 1)] } });
      applyQuestStatusChanges(
        quest,
        { promptMeta: { citables: [stamped('f2', 2), { id: 'f3', url: 'u-f3', title: 'f3' }] } },
        'user-1'
      );
      expect(quest.promptMeta?.citables?.map(c => c.metadata?.citationIndex)).toEqual([
        undefined,
        undefined,
        undefined,
      ]);
    });

    it('does not materialize an empty citables array on a first metadata write', () => {
      const quest = makeQuest();
      applyQuestStatusChanges(quest, { promptMeta: { warnings: ['w'] } }, 'user-1');
      expect(quest.promptMeta).not.toHaveProperty('citables');
    });

    it('merges and dedupes citables by stable identity', () => {
      const quest = makeQuest({
        promptMeta: { citables: [{ id: '1', url: 'u1', title: 't1' }] },
      } as Partial<IChatHistoryItemDocument>);
      applyQuestStatusChanges(
        quest,
        {
          promptMeta: {
            citables: [
              { id: '1', url: 'u1', title: 't1' },
              { id: '2', url: 'u2', title: 't2' },
            ],
          },
        } as Partial<IChatHistoryItemDocument>,
        'user-1'
      );
      expect(quest.promptMeta?.citables?.map(c => c.id)).toEqual(['1', '2']);
    });

    it('prefers the chip carrying a passage anchor when the same file arrives twice (#3038)', () => {
      // The same file can be cited by a file-level arm and a chunk-level one on the same turn.
      // First-wins would drop the anchored chip and with it the deep link into the passage.
      const quest = makeQuest({
        promptMeta: {
          citables: [
            { id: 'file-1', url: 'u1', title: 't1' },
            { id: 'file-2', url: 'u2', title: 't2' },
          ],
        },
      } as Partial<IChatHistoryItemDocument>);
      applyQuestStatusChanges(
        quest,
        {
          promptMeta: {
            citables: [{ id: 'file-1', url: 'u1', title: 't1', metadata: { chunkId: 'c1', fullContext: 'passage' } }],
          },
        } as Partial<IChatHistoryItemDocument>,
        'user-1'
      );
      // Position is the real assertion alongside the win: a citation marker [N] indexes this array,
      // so appending the winner instead of replacing in place would repoint every marker after it.
      expect(quest.promptMeta?.citables?.map(c => c.id)).toEqual(['file-1', 'file-2']);
      expect(quest.promptMeta?.citables?.[0].metadata?.fullContext).toBe('passage');
    });

    it('keeps the anchored chip when it arrives FIRST and a plain duplicate follows', () => {
      // The other arrival order - the anchored entry must not be overwritten by the later plain one.
      const quest = makeQuest({
        promptMeta: {
          citables: [{ id: 'file-1', url: 'u1', title: 't1', metadata: { chunkId: 'c1', fullContext: 'passage' } }],
        },
      } as Partial<IChatHistoryItemDocument>);
      applyQuestStatusChanges(
        quest,
        {
          promptMeta: { citables: [{ id: 'file-1', url: 'u1', title: 't1' }] },
        } as Partial<IChatHistoryItemDocument>,
        'user-1'
      );
      expect(quest.promptMeta?.citables?.map(c => c.id)).toEqual(['file-1']);
      expect(quest.promptMeta?.citables?.[0].metadata?.fullContext).toBe('passage');
    });

    it('unions conflict marks across the dedup instead of letting the anchor rule drop them (#3041)', () => {
      // The shape that makes this load-bearing: knowledgeBaseRetrieve stamps conflictsWith and
      // deliberately never carries a passage anchor, so on a turn that also searches the same file
      // the anchored search chip wins - and winner-takes-all would drop the conflict warning the
      // model was given, leaving the reader the only party unaware of it.
      const quest = makeQuest({
        promptMeta: {
          citables: [{ id: 'file-1', url: 'u1', title: 't1', metadata: { conflictsWith: ['file-9'] } }],
        },
      } as Partial<IChatHistoryItemDocument>);
      applyQuestStatusChanges(
        quest,
        {
          promptMeta: {
            citables: [{ id: 'file-1', url: 'u1', title: 't1', metadata: { chunkId: 'c1', fullContext: 'passage' } }],
          },
        } as Partial<IChatHistoryItemDocument>,
        'user-1'
      );

      // The anchored chip still wins the position and keeps its anchor...
      expect(quest.promptMeta?.citables?.[0].metadata?.fullContext).toBe('passage');
      // ...and the loser's conflict marks ride across onto it.
      expect(quest.promptMeta?.citables?.[0].metadata?.conflictsWith).toEqual(['file-9']);
    });

    it('dedups conflict marks when both chips carry overlapping ones', () => {
      const quest = makeQuest({
        promptMeta: {
          citables: [{ id: 'file-1', url: 'u1', title: 't1', metadata: { conflictsWith: ['file-9'] } }],
        },
      } as Partial<IChatHistoryItemDocument>);
      applyQuestStatusChanges(
        quest,
        {
          promptMeta: {
            citables: [{ id: 'file-1', url: 'u1', title: 't1', metadata: { conflictsWith: ['file-9', 'file-8'] } }],
          },
        } as Partial<IChatHistoryItemDocument>,
        'user-1'
      );

      expect(quest.promptMeta?.citables?.[0].metadata?.conflictsWith).toEqual(['file-9', 'file-8']);
    });

    it('leaves a chip with no conflict marks untouched by the union', () => {
      // The common case: the union must not stamp an empty array onto every deduped chip, which the
      // UI would read as a badge with no partner to name.
      const quest = makeQuest({
        promptMeta: { citables: [{ id: 'file-1', url: 'u1', title: 't1' }] },
      } as Partial<IChatHistoryItemDocument>);
      applyQuestStatusChanges(
        quest,
        {
          promptMeta: { citables: [{ id: 'file-1', url: 'u1', title: 't1' }] },
        } as Partial<IChatHistoryItemDocument>,
        'user-1'
      );

      expect(quest.promptMeta?.citables?.[0].metadata?.conflictsWith).toBeUndefined();
    });

    it('sets promptMeta when the quest had none', () => {
      const quest = makeQuest();
      applyQuestStatusChanges(
        quest,
        {
          promptMeta: { citables: [{ id: '1', url: 'u1', title: 't1' }] },
        } as Partial<IChatHistoryItemDocument>,
        'user-1'
      );
      expect(quest.promptMeta?.citables?.map(c => c.id)).toEqual(['1']);
    });
  });

  describe('promptMeta.session (bike4mind#2004)', () => {
    it('seeds session on the no-existing-meta branch instead of leaving it absent', () => {
      // This is the exact shape the issue reports on disk: promptMeta materialized with no
      // session block, which passes silently through update() (no validators) but fails
      // ValidationError the moment the quest is copied via create() (fork/snip/clone).
      const quest = makeQuest();
      applyQuestStatusChanges(quest, { promptMeta: { warnings: ['partial'] } }, 'user-1');
      expect(quest.promptMeta?.session).toEqual({ id: 's1', userId: 'user-1' });
    });

    it('seeds session on the merge branch when the existing promptMeta predates the fix', () => {
      // A legacy row can have promptMeta (with other fields) but still no session - the merge
      // branch below only guards on `quest.promptMeta` being truthy, so it can hit this shape too.
      const quest = makeQuest({ promptMeta: { warnings: ['keep me'] } } as Partial<IChatHistoryItemDocument>);
      applyQuestStatusChanges(quest, { promptMeta: { citables: [{ id: '1', url: 'u1', title: 't1' }] } }, 'user-1');
      expect(quest.promptMeta?.session).toEqual({ id: 's1', userId: 'user-1' });
    });

    it('re-asserts session even when the existing promptMeta already had one', () => {
      const quest = makeQuest({
        promptMeta: { session: { id: 's1', userId: 'user-1' } },
      } as Partial<IChatHistoryItemDocument>);
      applyQuestStatusChanges(quest, { promptMeta: { warnings: ['more'] } }, 'user-1');
      expect(quest.promptMeta?.session).toEqual({ id: 's1', userId: 'user-1' });
    });
  });

  describe('promptMeta.warnings', () => {
    it('accretes warnings from independent producers instead of overwriting', () => {
      // Response truncation and knowledge-base partial results each send only their own
      // string; a wholesale overwrite drops whichever landed first.
      const quest = makeQuest({
        promptMeta: { warnings: ['Response was truncated against the output-token limit.'] },
      } as Partial<IChatHistoryItemDocument>);
      applyQuestStatusChanges(
        quest,
        {
          promptMeta: { warnings: ['Partial knowledge-base results: 1 file(s) were excluded.'] },
        } as Partial<IChatHistoryItemDocument>,
        'user-1'
      );
      expect(quest.promptMeta?.warnings).toEqual([
        'Response was truncated against the output-token limit.',
        'Partial knowledge-base results: 1 file(s) were excluded.',
      ]);
    });

    it('dedupes an identical warning reported twice', () => {
      const quest = makeQuest({ promptMeta: { warnings: ['same'] } } as Partial<IChatHistoryItemDocument>);
      applyQuestStatusChanges(
        quest,
        { promptMeta: { warnings: ['same'] } } as Partial<IChatHistoryItemDocument>,
        'user-1'
      );
      expect(quest.promptMeta?.warnings).toEqual(['same']);
    });

    it('does not erase existing warnings when the change set carries none', () => {
      // Already held before the merge was added (spreading an object without the key cannot
      // delete it); locked here so the new merge does not regress it.
      const quest = makeQuest({ promptMeta: { warnings: ['keep me'] } } as Partial<IChatHistoryItemDocument>);
      applyQuestStatusChanges(
        quest,
        {
          promptMeta: { citables: [{ id: '1', url: 'u1', title: 't1' }] },
        } as Partial<IChatHistoryItemDocument>,
        'user-1'
      );
      expect(quest.promptMeta?.warnings).toEqual(['keep me']);
    });

    it('adds no warnings key when neither side has one', () => {
      const quest = makeQuest({ promptMeta: { citables: [] } } as Partial<IChatHistoryItemDocument>);
      applyQuestStatusChanges(quest, { promptMeta: { citables: [] } } as Partial<IChatHistoryItemDocument>, 'user-1');
      expect(quest.promptMeta && 'warnings' in quest.promptMeta).toBe(false);
    });
  });

  describe('retrieval', () => {
    it('merges a tool-arm write onto an existing forced-arm value instead of clobbering it', () => {
      const quest = makeQuest({
        promptMeta: {
          retrieval: { attempted: true, outcome: 'ok', surfaces: ['lake-memory'], dataLakeTags: ['lake-a'] },
        },
      } as Partial<IChatHistoryItemDocument>);
      applyQuestStatusChanges(
        quest,
        {
          promptMeta: {
            retrieval: { attempted: true, outcome: 'ok', surfaces: ['knowledgeBaseSearch'], dataLakeTags: ['lake-b'] },
          },
        } as Partial<IChatHistoryItemDocument>,
        'user-1'
      );
      expect(quest.promptMeta?.retrieval).toEqual({
        attempted: true,
        outcome: 'ok',
        surfaces: ['lake-memory', 'knowledgeBaseSearch'],
        dataLakeTags: ['lake-a', 'lake-b'],
      });
    });

    it('never lets a later ok mask an earlier failure within the same turn', () => {
      const quest = makeQuest({
        promptMeta: {
          retrieval: { attempted: true, outcome: 'failed', surfaces: ['lake-memory'], dataLakeTags: [] },
        },
      } as Partial<IChatHistoryItemDocument>);
      applyQuestStatusChanges(
        quest,
        {
          promptMeta: {
            retrieval: { attempted: true, outcome: 'ok', surfaces: ['knowledgeBaseSearch'], dataLakeTags: ['lake-a'] },
          },
        } as Partial<IChatHistoryItemDocument>,
        'user-1'
      );
      expect(quest.promptMeta?.retrieval?.outcome).toBe('failed');
    });

    it('never lets an abstain (no_lakes) on one surface mask a real success on another (#1971 review)', () => {
      // lake-memory abstains (no lakes in scope for that surface) while knowledgeBaseSearch
      // independently succeeds in the same turn -- the merged outcome must be 'ok', not
      // 'no_lakes', since the turn genuinely retrieved and grounded its answer.
      const quest = makeQuest({
        promptMeta: {
          retrieval: { attempted: true, outcome: 'no_lakes', surfaces: ['lake-memory'], dataLakeTags: [] },
        },
      } as Partial<IChatHistoryItemDocument>);
      applyQuestStatusChanges(
        quest,
        {
          promptMeta: {
            retrieval: { attempted: true, outcome: 'ok', surfaces: ['knowledgeBaseSearch'], dataLakeTags: ['lake-a'] },
          },
        } as Partial<IChatHistoryItemDocument>,
        'user-1'
      );
      expect(quest.promptMeta?.retrieval?.outcome).toBe('ok');
    });

    it('still lets a failure mask an earlier no_lakes abstain', () => {
      const quest = makeQuest({
        promptMeta: {
          retrieval: { attempted: true, outcome: 'no_lakes', surfaces: ['lake-memory'], dataLakeTags: [] },
        },
      } as Partial<IChatHistoryItemDocument>);
      applyQuestStatusChanges(
        quest,
        {
          promptMeta: {
            retrieval: { attempted: true, outcome: 'failed', surfaces: ['knowledgeBaseSearch'], dataLakeTags: [] },
          },
        } as Partial<IChatHistoryItemDocument>,
        'user-1'
      );
      expect(quest.promptMeta?.retrieval?.outcome).toBe('failed');
    });

    it('never lets a success on another surface erase an unsearchable corpus, in either order', () => {
      // The reason 'not_indexed' cannot be modelled at 'no_lakes' severity: an unindexed library
      // is a real, actionable defect, and the multi-surface turns where one surface still succeeds
      // are exactly the turns where diagnosis is hardest.
      // The SECOND arm is the load-bearing one: the merge keeps `existing` on a tie, so ranking
      // 'not_indexed' level with 'ok' trips only that direction. Arm 1 is strictly weaker (it fails
      // only when 'ok' outranks 'not_indexed', which also fails arm 2) and is kept to document the
      // intended symmetry, not for the coverage.
      const forcedFirst = makeQuest({
        promptMeta: {
          retrieval: { attempted: true, outcome: 'not_indexed', surfaces: ['forced-retrieval'], dataLakeTags: [] },
        },
      } as Partial<IChatHistoryItemDocument>);
      applyQuestStatusChanges(
        forcedFirst,
        {
          promptMeta: {
            retrieval: { attempted: true, outcome: 'ok', surfaces: ['knowledgeBaseSearch'], dataLakeTags: ['lake-a'] },
          },
        } as Partial<IChatHistoryItemDocument>,
        'user-1'
      );
      expect(forcedFirst.promptMeta?.retrieval?.outcome).toBe('not_indexed');

      const searchFirst = makeQuest({
        promptMeta: {
          retrieval: { attempted: true, outcome: 'ok', surfaces: ['knowledgeBaseSearch'], dataLakeTags: ['lake-a'] },
        },
      } as Partial<IChatHistoryItemDocument>);
      applyQuestStatusChanges(
        searchFirst,
        {
          promptMeta: {
            retrieval: { attempted: true, outcome: 'not_indexed', surfaces: ['forced-retrieval'], dataLakeTags: [] },
          },
        } as Partial<IChatHistoryItemDocument>,
        'user-1'
      );
      expect(searchFirst.promptMeta?.retrieval?.outcome).toBe('not_indexed');
    });

    it('still lets a genuine failure outrank an unsearchable corpus', () => {
      // The other boundary of the new severity slot: an outage is acute and retryable, so it stays
      // the headline when both conditions land in one turn.
      const quest = makeQuest({
        promptMeta: {
          retrieval: { attempted: true, outcome: 'not_indexed', surfaces: ['forced-retrieval'], dataLakeTags: [] },
        },
      } as Partial<IChatHistoryItemDocument>);
      applyQuestStatusChanges(
        quest,
        {
          promptMeta: {
            retrieval: { attempted: true, outcome: 'failed', surfaces: ['knowledgeBaseSearch'], dataLakeTags: [] },
          },
        } as Partial<IChatHistoryItemDocument>,
        'user-1'
      );
      expect(quest.promptMeta?.retrieval?.outcome).toBe('failed');
    });

    it('dedupes the union of surfaces/dataLakeTags rather than replacing with the incoming value', () => {
      // Partially overlapping, not identical, on both sides: an incoming write that shares ONE
      // entry with the existing state and adds ONE new entry can only produce the full union
      // (both old and new) via a real merge. A wholesale overwrite would drop 'lake-memory' and
      // 'lake-a' entirely, since neither appears in the incoming payload - so this distinguishes
      // dedup-merge from overwrite, which a repeated-identical-call test cannot (#1867 review).
      const quest = makeQuest({
        promptMeta: {
          retrieval: {
            attempted: true,
            outcome: 'ok',
            surfaces: ['knowledgeBaseSearch', 'lake-memory'],
            dataLakeTags: ['lake-a'],
          },
        },
      } as Partial<IChatHistoryItemDocument>);
      applyQuestStatusChanges(
        quest,
        {
          promptMeta: {
            retrieval: {
              attempted: true,
              outcome: 'ok',
              surfaces: ['knowledgeBaseSearch', 'knowledgeBaseRetrieve'],
              dataLakeTags: ['lake-a', 'lake-b'],
            },
          },
        } as Partial<IChatHistoryItemDocument>,
        'user-1'
      );
      expect(quest.promptMeta?.retrieval?.surfaces).toEqual([
        'knowledgeBaseSearch',
        'lake-memory',
        'knowledgeBaseRetrieve',
      ]);
      expect(quest.promptMeta?.retrieval?.dataLakeTags).toEqual(['lake-a', 'lake-b']);
    });

    it('does not erase an existing retrieval value when the change set carries none', () => {
      const quest = makeQuest({
        promptMeta: {
          retrieval: { attempted: true, outcome: 'ok', surfaces: ['lake-memory'], dataLakeTags: ['lake-a'] },
        },
      } as Partial<IChatHistoryItemDocument>);
      applyQuestStatusChanges(
        quest,
        {
          promptMeta: { citables: [{ id: '1', url: 'u1', title: 't1' }] },
        } as Partial<IChatHistoryItemDocument>,
        'user-1'
      );
      expect(quest.promptMeta?.retrieval).toEqual({
        attempted: true,
        outcome: 'ok',
        surfaces: ['lake-memory'],
        dataLakeTags: ['lake-a'],
      });
    });
  });

  describe('other fields', () => {
    it('overwrites non-accreting fields wholesale', () => {
      const quest = makeQuest({ status: 'running' } as Partial<IChatHistoryItemDocument>);
      applyQuestStatusChanges(quest, { status: 'done', reply: 'final' } as Partial<IChatHistoryItemDocument>, 'user-1');
      expect(quest.status).toBe('done');
      expect(quest.reply).toBe('final');
    });

    it('applies images and other fields together in one call', () => {
      const quest = makeQuest({ images: ['a.jpg'] });
      applyQuestStatusChanges(
        quest,
        {
          images: ['b.jpg'],
          status: 'done',
        } as Partial<IChatHistoryItemDocument>,
        'user-1'
      );
      expect(quest.images).toEqual(['a.jpg', 'b.jpg']);
      expect(quest.status).toBe('done');
    });
  });
});
