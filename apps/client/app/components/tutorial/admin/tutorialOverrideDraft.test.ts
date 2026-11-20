import { describe, expect, it } from 'vitest';
import type { TutorialStep } from '@bike4mind/common';
import {
  anchorValue,
  copyValue,
  diffOf,
  draftFrom,
  moveStep,
  orderOf,
  resetStep,
  sameDraft,
  setAnchor,
  setCopy,
  setTurn,
  turnValue,
  unitsOf,
} from './tutorialOverrideDraft';

const step = (id: string, extra: Partial<TutorialStep> = {}) =>
  ({ id, type: 'point', title: `${id} title`, body: `${id} body`, ...extra }) as TutorialStep;

const a = step('a', { anchor: 'send-message-btn', placement: 'above' });
const b = step('b', { turn: 1 });
const c = step('c');
const ids = ['a', 'b', 'c'];
const turn1 = { turn: 1, prompt: 'Ask it', reply: 'Answer' };

describe('copy edits', () => {
  it('holds a unit only while the text differs from the repo', () => {
    const edited = setCopy({}, a, 'body', 'Fixed body');
    expect(copyValue(edited, a, 'body')).toBe('Fixed body');
    expect(unitsOf(edited)).toEqual([
      { kind: 'copy', stepId: 'a', field: 'body', value: 'Fixed body', repoValue: 'a body' },
    ]);
    expect(unitsOf(setCopy(edited, a, 'body', 'a body'))).toEqual([]);
  });
});

describe('anchor edits', () => {
  it('edits the unit as one value, cleans empty picks, and drops a unit equal to the repo', () => {
    expect(anchorValue({}, a)).toEqual({ anchor: 'send-message-btn', placement: 'above' });
    const moved = setAnchor({}, a, { anchor: 'attach-files-btn', placement: 'above', avoid: '' });
    expect(moved['anchor:a']).toEqual({
      kind: 'anchor',
      stepId: 'a',
      value: { anchor: 'attach-files-btn', placement: 'above' },
      repoValue: { anchor: 'send-message-btn', placement: 'above' },
    });
    expect(unitsOf(setAnchor(moved, a, { anchor: 'send-message-btn', placement: 'above' }))).toEqual([]);
  });
});

describe('turn edits', () => {
  it('saves a reply alone as a reply unit', () => {
    const draft = setTurn({}, turn1, { prompt: 'Ask it', reply: 'Better' });
    expect(draft['turn:1']).toEqual({ kind: 'reply', turn: 1, value: 'Better', repoValue: 'Answer' });
    expect(turnValue(draft, turn1)).toEqual({ prompt: 'Ask it', reply: 'Better' });
  });

  it('carries the reply with a changed prompt, and drops the unit once both match the repo', () => {
    const draft = setTurn({}, turn1, { prompt: 'Ask better', reply: 'Answer' });
    expect(draft['turn:1']).toEqual({
      kind: 'prompt',
      turn: 1,
      value: { prompt: 'Ask better', reply: 'Answer' },
      repoValue: { prompt: 'Ask it', reply: 'Answer' },
    });
    expect(unitsOf(setTurn(draft, turn1, { prompt: 'Ask it', reply: 'Answer' }))).toEqual([]);
  });
});

describe('order edits', () => {
  it('moves a step, refuses to move past either end, and drops the unit when back to the repo order', () => {
    const down = moveStep({}, ids, 'a', 1);
    expect(orderOf(down, ids)).toEqual(['b', 'a', 'c']);
    expect(moveStep(down, ids, 'c', 1)).toBe(down);
    expect(unitsOf(moveStep(down, ids, 'a', -1))).toEqual([]);
  });

  it('falls back to the repo order when the saved one names other steps', () => {
    const draft = draftFrom([{ kind: 'order', value: ['b', 'a'], repoValue: ['a', 'b'] }]);
    expect(orderOf(draft, ids)).toEqual(ids);
  });
});

describe('resetStep', () => {
  it('drops the step copy, anchor and turn, and keeps the order and other steps', () => {
    let draft = setCopy({}, b, 'title', 'New');
    draft = setTurn(draft, turn1, { prompt: 'Ask it', reply: 'Better' });
    draft = setCopy(draft, c, 'body', 'Other');
    draft = moveStep(draft, ids, 'c', -1);
    expect(Object.keys(resetStep(draft, b)).sort()).toEqual(['copy:c:body', 'order']);
  });
});

describe('diffOf and sameDraft', () => {
  it('lists edits by key with the repo value first, and compares drafts by content', () => {
    const draft = setCopy(setTurn({}, turn1, { prompt: 'Ask it', reply: 'Better' }), a, 'title', 'T');
    expect(diffOf(draft)).toEqual([
      { key: 'copy:a:title', before: 'a title', after: 'T' },
      { key: 'turn:1', before: 'Answer', after: 'Better' },
    ]);
    expect(sameDraft(draft, draftFrom(unitsOf(draft).reverse()))).toBe(true);
    expect(sameDraft(draft, {})).toBe(false);
  });
});
