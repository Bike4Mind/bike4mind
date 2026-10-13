import { describe, it, expect } from 'vitest';
import { foldHistoryEntry } from '../TavernWorldModel';

const CAP = 3;

describe('foldHistoryEntry', () => {
  it('user append under the cap grows history and advances the pointer', () => {
    expect(foldHistoryEntry(['a'], 1, 'user', 'b', CAP)).toEqual({ history: ['a', 'b'], undoPointer: 2 });
  });

  it('user edit after undo drops the redo entries', () => {
    expect(foldHistoryEntry(['a', 'b', 'c'], 1, 'user', 'x', CAP)).toEqual({ history: ['a', 'x'], undoPointer: 2 });
  });

  it.each(['agent', 'system'] as const)('%s edit after undo inserts at the pointer and keeps redo', source => {
    expect(foldHistoryEntry(['a', 'b'], 1, source, 'x', CAP)).toEqual({ history: ['a', 'x', 'b'], undoPointer: 2 });
  });

  it('user append at the cap evicts the oldest and keeps the pointer at the cap', () => {
    expect(foldHistoryEntry(['a', 'b', 'c'], 3, 'user', 'x', CAP)).toEqual({
      history: ['b', 'c', 'x'],
      undoPointer: 3,
    });
  });

  it('agent insert mid-history at the cap evicts the oldest and keeps the pointer in place', () => {
    expect(foldHistoryEntry(['a', 'b', 'c'], 2, 'agent', 'x', CAP)).toEqual({
      history: ['b', 'x', 'c'],
      undoPointer: 2,
    });
  });

  it.each(['agent', 'system'] as const)(
    '%s insert with the pointer at the end of a full history evicts the oldest',
    source => {
      expect(foldHistoryEntry(['a', 'b', 'c'], 3, source, 'x', CAP)).toEqual({
        history: ['b', 'c', 'x'],
        undoPointer: 3,
      });
    }
  );

  // Known quirk, kept as-is: the new entry is inserted at index 0 and evicted at once, so it is never undoable.
  it('agent insert at pointer 0 with a full history evicts the new entry itself', () => {
    expect(foldHistoryEntry(['a', 'b', 'c'], 0, 'agent', 'x', CAP)).toEqual({
      history: ['a', 'b', 'c'],
      undoPointer: 0,
    });
  });

  it('does not mutate the input history', () => {
    const history = ['a', 'b', 'c'];
    foldHistoryEntry(history, 1, 'user', 'x', CAP);
    foldHistoryEntry(history, 1, 'agent', 'x', CAP);
    expect(history).toEqual(['a', 'b', 'c']);
  });
});
