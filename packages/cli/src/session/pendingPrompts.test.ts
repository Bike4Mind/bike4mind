import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCliStore } from '../store/index.js';
import { settlePendingPrompts } from './pendingPrompts.js';

afterEach(() => {
  useCliStore.setState({
    permissionPrompt: null,
    permissionQueue: [],
    userQuestionPrompt: null,
    userQuestionQueue: [],
    reviewGatePrompt: null,
    reviewGateQueue: [],
  });
});

describe('settlePendingPrompts', () => {
  it('denies every permission prompt, cancels every question and review gate, and empties the queues', () => {
    const store = useCliStore.getState();
    const permission = [vi.fn(), vi.fn()];
    const question = [vi.fn(), vi.fn()];
    const gate = [vi.fn(), vi.fn()];
    permission.forEach((resolve, i) =>
      store.enqueuePermissionPrompt({
        id: `perm-${i}`,
        toolName: 'bash_execute',
        args: {},
        canBeTrusted: true,
        resolve,
      })
    );
    question.forEach((resolve, i) =>
      store.enqueueUserQuestionPrompt({ id: `uq-${i}`, payload: { questions: [] } as never, resolve })
    );
    gate.forEach((resolve, i) => store.enqueueReviewGatePrompt({ id: `gate-${i}`, description: 'ship it?', resolve }));

    settlePendingPrompts();

    for (const resolve of permission) expect(resolve).toHaveBeenCalledWith({ action: 'deny' });
    for (const resolve of question) expect(resolve).toHaveBeenCalledWith({ answers: [] });
    for (const resolve of gate) {
      expect(resolve).toHaveBeenCalledWith({ decision: 'rejected', note: expect.stringContaining('ended') });
    }
    expect(useCliStore.getState()).toMatchObject({
      permissionPrompt: null,
      permissionQueue: [],
      userQuestionPrompt: null,
      userQuestionQueue: [],
      reviewGatePrompt: null,
      reviewGateQueue: [],
    });
  });
});
