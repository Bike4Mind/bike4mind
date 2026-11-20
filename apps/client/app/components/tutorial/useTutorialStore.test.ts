import { describe, expect, it } from 'vitest';
import { createTutorialStore } from './useTutorialStore';

const ACTIVE = { moduleId: 'demo', sessionId: 's1', stepId: 'intro' };
const JUMP = { moduleId: 'demo', stepId: 'wrap' };

describe('tutorial store jumps', () => {
  it('drops a queued jump when the walk ends', () => {
    const store = createTutorialStore();
    store.getState().begin(ACTIVE);
    store.getState().requestJump(JUMP);
    store.getState().end();
    expect(store.getState().pendingJump).toBeNull();
  });

  it('keeps a queued jump when a walk begins, so a jump can start its module', () => {
    const store = createTutorialStore();
    store.getState().requestJump(JUMP);
    store.getState().begin(ACTIVE);
    expect(store.getState().pendingJump).toEqual(JUMP);
  });
});
