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
