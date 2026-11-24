import { describe, expect, it } from 'vitest';
import type { ChatStreamEvent } from '@shared/chat';
import { StreamResumeGate } from './streamResume';

const delta = (sessionId: string, seq: number | undefined, text = 't'): ChatStreamEvent => ({
  type: 'delta',
  sessionId,
  messageId: 'm',
  text,
  ...(seq === undefined ? {} : { seq }),
});

describe('StreamResumeGate', () => {
  it("holds the opening chat's sequenced events and hands back only those after the cursor", () => {
    const gate = new StreamResumeGate();
    gate.hold('s1');
    expect(gate.admit(delta('s1', 4))).toBe('hold');
    expect(gate.admit(delta('s1', 5))).toBe('hold');
    expect(gate.admit(delta('s1', 6))).toBe('hold');
    expect(gate.resolve({ epoch: 'e', seq: 5 }).map(event => event.seq)).toEqual([6]);
    expect(gate.admit(delta('s1', 5))).toBe('drop');
    expect(gate.admit(delta('s1', 7))).toBe('apply');
  });

  it('applies events of other chats and unsequenced events at once', () => {
    const gate = new StreamResumeGate();
    gate.hold('s1');
    expect(gate.admit(delta('s2', 1))).toBe('apply');
    expect(gate.admit(delta('s1', undefined))).toBe('apply');
    expect(gate.resolve({ epoch: 'e', seq: 0 })).toEqual([]);
  });

  it('keeps what it holds across a re-read of the same chat', () => {
    const gate = new StreamResumeGate();
    gate.hold('s1');
    gate.admit(delta('s1', 3));
    gate.hold('s1');
    gate.admit(delta('s1', 4));
    expect(gate.resolve({ epoch: 'e', seq: 3 }).map(event => event.seq)).toEqual([4]);
  });

  it('hands back everything and stops dropping when released without a snapshot', () => {
    const gate = new StreamResumeGate();
    gate.hold('s1');
    gate.resolve({ epoch: 'e', seq: 2 });
    gate.hold('s1');
    gate.admit(delta('s1', 3));
    expect(gate.release().map(event => event.seq)).toEqual([3]);
    expect(gate.admit(delta('s1', 1))).toBe('apply');
  });

  it('forgets the previous chat cursor when another chat opens', () => {
    const gate = new StreamResumeGate();
    gate.hold('s1');
    gate.resolve({ epoch: 'e', seq: 9 });
    gate.hold('s2');
    expect(gate.reflects(delta('s1', 2))).toBe(false);
    expect(gate.admit(delta('s1', 2))).toBe('apply');
  });

  it('applies everything held when the read carries no cursor', () => {
    const gate = new StreamResumeGate();
    gate.hold('s1');
    gate.admit(delta('s1', 1));
    expect(gate.resolve(undefined).map(event => event.seq)).toEqual([1]);
    expect(gate.admit(delta('s1', 1))).toBe('apply');
  });
});
