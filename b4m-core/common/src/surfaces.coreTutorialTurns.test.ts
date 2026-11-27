import { describe, expect, it, vi } from 'vitest';
import { coreTutorialAnswersTurns, respondFromCoreTutorial, type CoreTutorialTurnHook } from './surfaces';

const quest = { id: 'q', prompt: 'p' };
const marked = { id: 's', tutorial: { owner: 'core' as const, moduleId: 'm' } };

function hook(): CoreTutorialTurnHook {
  return {
    respond: vi.fn().mockResolvedValue({ replies: ['scripted'] }),
    answersTurns: vi.fn().mockResolvedValue(true),
  };
}

describe('core tutorial turn helpers', () => {
  it('never call the hook for a session without a core marker', async () => {
    const h = hook();
    for (const session of [{ id: 's' }, { id: 's', tutorial: null }]) {
      expect(await respondFromCoreTutorial({ user: {}, session, quest }, h)).toBeNull();
      expect(await coreTutorialAnswersTurns({ user: {}, session }, h)).toBe(false);
    }
    expect(h.respond).not.toHaveBeenCalled();
    expect(h.answersTurns).not.toHaveBeenCalled();
  });

  it('answer from the hook for a marked session, and stay quiet without one', async () => {
    expect(await respondFromCoreTutorial({ user: {}, session: marked, quest }, hook())).toEqual({
      replies: ['scripted'],
    });
    expect(await respondFromCoreTutorial({ user: {}, session: marked, quest }, undefined)).toBeNull();
    expect(await coreTutorialAnswersTurns({ user: {}, session: marked }, undefined)).toBe(false);
  });

  it('hand a failing or empty reply to the model, and a failing predicate to the caller default', async () => {
    const failing: CoreTutorialTurnHook = {
      respond: vi.fn().mockRejectedValue(new Error('boom')),
      answersTurns: vi.fn().mockRejectedValue(new Error('boom')),
    };
    expect(await respondFromCoreTutorial({ user: {}, session: marked, quest }, failing)).toBeNull();
    expect(await coreTutorialAnswersTurns({ user: {}, session: marked }, failing, false)).toBe(false);
    expect(await coreTutorialAnswersTurns({ user: {}, session: marked }, failing, true)).toBe(true);
    const empty = { ...failing, respond: vi.fn().mockResolvedValue({ replies: [] }) };
    expect(await respondFromCoreTutorial({ user: {}, session: marked, quest }, empty)).toBeNull();
  });
});
