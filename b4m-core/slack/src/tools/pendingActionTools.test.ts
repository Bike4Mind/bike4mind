import { describe, it, expect, vi } from 'vitest';
import { createPendingActionToolDefs } from './pendingActionTools';

describe('createPendingActionToolDefs', () => {
  // Executing a pending action is what the human's Confirm click authorizes, so the model must
  // never be handed a tool that does it.
  it('offers the model a cancel tool and no confirm tool', () => {
    const tools = createPendingActionToolDefs({
      sessionId: 'session-1',
      cancelPendingAction: vi.fn(),
      findQuestWithPendingAction: vi.fn(),
    });

    expect(Object.keys(tools)).toEqual(['cancel_pending_action']);
  });
});
