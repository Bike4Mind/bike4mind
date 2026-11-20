import { describe, expect, it } from 'vitest';
import { holdsPrompt, OUTPUT_RESERVE_TOKENS, replyRoom } from './contextBudget';

describe('replyRoom', () => {
  it('reserves the asked-for reply, capped at a quarter of the context', () => {
    expect(replyRoom(32_768)).toBe(OUTPUT_RESERVE_TOKENS);
    expect(replyRoom(32_768, 1_000)).toBe(1_000);
    expect(replyRoom(4_096)).toBe(1_024);
  });
});

describe('holdsPrompt', () => {
  it('is true only when the prompt and the reply room both fit', () => {
    expect(holdsPrompt(4_096, 3_072)).toBe(true);
    expect(holdsPrompt(4_096, 3_073)).toBe(false);
    expect(holdsPrompt(8_192, 7_692, 500)).toBe(true);
    expect(holdsPrompt(8_192, 7_693, 500)).toBe(false);
  });
});
