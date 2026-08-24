import { describe, it, expect } from 'vitest';
import type { IChatHistoryItemDocument } from '@bike4mind/common';
import { applyQuestStatusChanges } from './ToolBuilder';

// Minimal quest factory - only the fields applyQuestStatusChanges touches matter.
function makeQuest(overrides: Partial<IChatHistoryItemDocument> = {}): IChatHistoryItemDocument {
  return { id: 'q1', sessionId: 's1', ...overrides } as IChatHistoryItemDocument;
}

describe('applyQuestStatusChanges', () => {
  describe('images (multi-image-generation persistence bug)', () => {
    it('appends images across multiple calls instead of overwriting', () => {
      // Repro of the prod bug: 4 separate image_generation tool calls, each
      // sending only its own image through statusUpdate. Wholesale overwrite
      // collapsed this to "Image 1 of 1"; merge-append must keep all four.
      const quest = makeQuest();
      applyQuestStatusChanges(quest, { images: ['a.jpg'] });
      applyQuestStatusChanges(quest, { images: ['b.jpg'] });
      applyQuestStatusChanges(quest, { images: ['c.jpg'] });
      applyQuestStatusChanges(quest, { images: ['d.jpg'] });
      expect(quest.images).toEqual(['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg']);
    });

    it('appends a multi-image batch from a single call', () => {
      const quest = makeQuest({ images: ['a.jpg'] });
      applyQuestStatusChanges(quest, { images: ['b.jpg', 'c.jpg'] });
      expect(quest.images).toEqual(['a.jpg', 'b.jpg', 'c.jpg']);
    });

    it('dedupes already-present paths (idempotent with onToolFinish append)', () => {
      const quest = makeQuest({ images: ['a.jpg'] });
      applyQuestStatusChanges(quest, { images: ['a.jpg'] });
      expect(quest.images).toEqual(['a.jpg']);
    });

    it('initializes images when the quest has none', () => {
      const quest = makeQuest();
      applyQuestStatusChanges(quest, { images: ['a.jpg'] });
      expect(quest.images).toEqual(['a.jpg']);
    });

    it('leaves images untouched when the change set has none', () => {
      const quest = makeQuest({ images: ['a.jpg'] });
      applyQuestStatusChanges(quest, { reply: 'hi' } as Partial<IChatHistoryItemDocument>);
      expect(quest.images).toEqual(['a.jpg']);
    });
  });

  describe('promptMeta.citables', () => {
    it('merges and dedupes citables by stable identity', () => {
      const quest = makeQuest({
        promptMeta: { citables: [{ id: '1', url: 'u1', title: 't1' }] },
      } as Partial<IChatHistoryItemDocument>);
      applyQuestStatusChanges(quest, {
        promptMeta: {
          citables: [
            { id: '1', url: 'u1', title: 't1' },
            { id: '2', url: 'u2', title: 't2' },
          ],
        },
      } as Partial<IChatHistoryItemDocument>);
      expect(quest.promptMeta?.citables?.map(c => c.id)).toEqual(['1', '2']);
    });

    it('sets promptMeta when the quest had none', () => {
      const quest = makeQuest();
      applyQuestStatusChanges(quest, {
        promptMeta: { citables: [{ id: '1', url: 'u1', title: 't1' }] },
      } as Partial<IChatHistoryItemDocument>);
      expect(quest.promptMeta?.citables?.map(c => c.id)).toEqual(['1']);
    });
  });

  describe('promptMeta.warnings', () => {
    it('accretes warnings from independent producers instead of overwriting', () => {
      // Response truncation and knowledge-base partial results each send only their own
      // string; a wholesale overwrite drops whichever landed first.
      const quest = makeQuest({
        promptMeta: { warnings: ['Response was truncated against the output-token limit.'] },
      } as Partial<IChatHistoryItemDocument>);
      applyQuestStatusChanges(quest, {
        promptMeta: { warnings: ['Partial knowledge-base results: 1 file(s) were excluded.'] },
      } as Partial<IChatHistoryItemDocument>);
      expect(quest.promptMeta?.warnings).toEqual([
        'Response was truncated against the output-token limit.',
        'Partial knowledge-base results: 1 file(s) were excluded.',
      ]);
    });

    it('dedupes an identical warning reported twice', () => {
      const quest = makeQuest({ promptMeta: { warnings: ['same'] } } as Partial<IChatHistoryItemDocument>);
      applyQuestStatusChanges(quest, { promptMeta: { warnings: ['same'] } } as Partial<IChatHistoryItemDocument>);
      expect(quest.promptMeta?.warnings).toEqual(['same']);
    });

    it('does not erase existing warnings when the change set carries none', () => {
      // Already held before the merge was added (spreading an object without the key cannot
      // delete it); locked here so the new merge does not regress it.
      const quest = makeQuest({ promptMeta: { warnings: ['keep me'] } } as Partial<IChatHistoryItemDocument>);
      applyQuestStatusChanges(quest, {
        promptMeta: { citables: [{ id: '1', url: 'u1', title: 't1' }] },
      } as Partial<IChatHistoryItemDocument>);
      expect(quest.promptMeta?.warnings).toEqual(['keep me']);
    });

    it('adds no warnings key when neither side has one', () => {
      const quest = makeQuest({ promptMeta: { citables: [] } } as Partial<IChatHistoryItemDocument>);
      applyQuestStatusChanges(quest, { promptMeta: { citables: [] } } as Partial<IChatHistoryItemDocument>);
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
      applyQuestStatusChanges(quest, {
        promptMeta: {
          retrieval: { attempted: true, outcome: 'ok', surfaces: ['knowledgeBaseSearch'], dataLakeTags: ['lake-b'] },
        },
      } as Partial<IChatHistoryItemDocument>);
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
      applyQuestStatusChanges(quest, {
        promptMeta: {
          retrieval: { attempted: true, outcome: 'ok', surfaces: ['knowledgeBaseSearch'], dataLakeTags: ['lake-a'] },
        },
      } as Partial<IChatHistoryItemDocument>);
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
      applyQuestStatusChanges(quest, {
        promptMeta: {
          retrieval: { attempted: true, outcome: 'ok', surfaces: ['knowledgeBaseSearch'], dataLakeTags: ['lake-a'] },
        },
      } as Partial<IChatHistoryItemDocument>);
      expect(quest.promptMeta?.retrieval?.outcome).toBe('ok');
    });

    it('still lets a failure mask an earlier no_lakes abstain', () => {
      const quest = makeQuest({
        promptMeta: {
          retrieval: { attempted: true, outcome: 'no_lakes', surfaces: ['lake-memory'], dataLakeTags: [] },
        },
      } as Partial<IChatHistoryItemDocument>);
      applyQuestStatusChanges(quest, {
        promptMeta: {
          retrieval: { attempted: true, outcome: 'failed', surfaces: ['knowledgeBaseSearch'], dataLakeTags: [] },
        },
      } as Partial<IChatHistoryItemDocument>);
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
      applyQuestStatusChanges(quest, {
        promptMeta: {
          retrieval: {
            attempted: true,
            outcome: 'ok',
            surfaces: ['knowledgeBaseSearch', 'knowledgeBaseRetrieve'],
            dataLakeTags: ['lake-a', 'lake-b'],
          },
        },
      } as Partial<IChatHistoryItemDocument>);
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
      applyQuestStatusChanges(quest, {
        promptMeta: { citables: [{ id: '1', url: 'u1', title: 't1' }] },
      } as Partial<IChatHistoryItemDocument>);
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
      applyQuestStatusChanges(quest, { status: 'done', reply: 'final' } as Partial<IChatHistoryItemDocument>);
      expect(quest.status).toBe('done');
      expect(quest.reply).toBe('final');
    });

    it('applies images and other fields together in one call', () => {
      const quest = makeQuest({ images: ['a.jpg'] });
      applyQuestStatusChanges(quest, {
        images: ['b.jpg'],
        status: 'done',
      } as Partial<IChatHistoryItemDocument>);
      expect(quest.images).toEqual(['a.jpg', 'b.jpg']);
      expect(quest.status).toBe('done');
    });
  });
});
