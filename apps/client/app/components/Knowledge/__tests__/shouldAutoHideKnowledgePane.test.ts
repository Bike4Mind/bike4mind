import { describe, it, expect } from 'vitest';
import { shouldAutoHideKnowledgePane, shouldArmKnowledgePaneLatch } from '../KnowledgeViewer';

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

describe('shouldArmKnowledgePaneLatch', () => {
  it('arms on a session-stable render that shows content', () => {
    expect(shouldArmKnowledgePaneLatch({ hasSelected: true, hasTrustedItems: false, sessionChanged: false })).toBe(
      true
    );
  });

  it('arms on the session-change render when the new session already has cached items', () => {
    // Returning to a warm session: its file list is served synchronously from the query cache
    // while the id flips, and the effect only re-runs on a length change - so this render is
    // the only chance to arm. Without it, deleting that session's last file would not collapse.
    expect(shouldArmKnowledgePaneLatch({ hasSelected: true, hasTrustedItems: true, sessionChanged: true })).toBe(true);
  });

  it('does not arm on a session-change render carrying only the previous session transient items', () => {
    // recentArtifacts / previewFile lag the id flip by one commit; arming from them would let a
    // stale list mark a genuinely empty new session as safe to collapse.
    expect(shouldArmKnowledgePaneLatch({ hasSelected: true, hasTrustedItems: false, sessionChanged: true })).toBe(
      false
    );
  });

  it('arms on the session-change render from content that is not session-transient', () => {
    // The trusted count also carries user/global-scoped system prompt files, which describe the
    // current render and cannot be the previous session's stale list.
    expect(shouldArmKnowledgePaneLatch({ hasSelected: true, hasTrustedItems: true, sessionChanged: true })).toBe(true);
  });

  it('never arms while the pane is empty', () => {
    for (const hasTrustedItems of [true, false]) {
      for (const sessionChanged of [true, false]) {
        expect(shouldArmKnowledgePaneLatch({ hasSelected: false, hasTrustedItems, sessionChanged })).toBe(false);
      }
    }
  });

  it('keeps the delete-all collapse working across A -> cached B -> delete-final-item', () => {
    // Render 1: switch to A, which has nothing (latch stays disarmed).
    let latch = shouldArmKnowledgePaneLatch({ hasSelected: false, hasTrustedItems: false, sessionChanged: true });
    expect(latch).toBe(false);

    // Render 2: back to B. B's cached files are present on the very render the id flips.
    latch = shouldArmKnowledgePaneLatch({ hasSelected: true, hasTrustedItems: true, sessionChanged: true });
    expect(latch).toBe(true);

    // Delete B's final item - the pane must collapse again.
    expect(shouldAutoHideKnowledgePane({ isEmpty: true, hasShownItems: latch, autoHideOnEmpty: true })).toBe(true);
  });
});
