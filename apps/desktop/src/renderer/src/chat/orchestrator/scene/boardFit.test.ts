import { describe, expect, it } from 'vitest';
import { pinNotes } from './boardFit';

describe('pinNotes', () => {
  it('pins everything when it fits', () => {
    expect(pinNotes([1, 2, 3], 3)).toEqual({ pinned: [1, 2, 3], hidden: [] });
  });

  it('gives the last place to the "+N" note once the board is over full', () => {
    expect(pinNotes([1, 2, 3, 4, 5], 3)).toEqual({ pinned: [1, 2], hidden: [3, 4, 5] });
  });
});
