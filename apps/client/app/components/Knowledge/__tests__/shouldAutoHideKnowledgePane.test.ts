import { describe, it, expect } from 'vitest';
import { shouldAutoHideKnowledgePane } from '../KnowledgeViewer';

describe('shouldAutoHideKnowledgePane', () => {
  it('does not hide a pane that has been empty since mount', () => {
    // Explicit "Open Knowledge Base" on an empty session, and a cold reload while the
    // session's sources are still loading. Both are mount-time empties and must stay open.
    expect(
      shouldAutoHideKnowledgePane({
        isEmpty: true,
        hasShownItems: false,
        autoHideOnEmpty: true,
      })
    ).toBe(false);
  });

  it('hides a pane that was emptied after it had shown items', () => {
    // The prop's original purpose: deleting every file / clearing every artifact.
    expect(
      shouldAutoHideKnowledgePane({
        isEmpty: true,
        hasShownItems: true,
        autoHideOnEmpty: true,
      })
    ).toBe(true);
  });

  it('never hides while the pane is non-empty', () => {
    for (const hasShownItems of [true, false]) {
      for (const autoHideOnEmpty of [true, false]) {
        expect(shouldAutoHideKnowledgePane({ isEmpty: false, hasShownItems, autoHideOnEmpty })).toBe(false);
      }
    }
  });

  it('respects autoHideOnEmpty=false for every combination', () => {
    for (const isEmpty of [true, false]) {
      for (const hasShownItems of [true, false]) {
        expect(shouldAutoHideKnowledgePane({ isEmpty, hasShownItems, autoHideOnEmpty: false })).toBe(false);
      }
    }
  });
});
