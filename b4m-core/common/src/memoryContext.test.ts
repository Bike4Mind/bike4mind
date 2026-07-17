import { describe, expect, it } from 'vitest';
import { buildMemoryContext } from './memoryContext';

/**
 * The framing here was chosen by measurement (A/B'd on real recalled facts and real questions, judged
 * for transcript-talk): the per-message `[Memory] <fact>` format scored 33%, this one 0%. These pin the
 * properties that made the difference, so a well-meaning reword cannot quietly bring the reciting back.
 */
describe('buildMemoryContext', () => {
  it('includes every fact', () => {
    const out = buildMemoryContext(['Uses a MacBook Pro M4 Max', 'Lives in Austin, TX']);
    expect(out).toContain('Uses a MacBook Pro M4 Max');
    expect(out).toContain('Lives in Austin, TX');
  });

  it('carries NO retrieval metadata - no scores, no "Memory" labels, no dossier header', () => {
    // Every one of these is a tell that invites the model to talk ABOUT its memory instead of using it,
    // and every one shipped in a real injection site before this consolidation.
    const out = buildMemoryContext(['Favorite color is green']);
    expect(out).not.toMatch(/% relevant/);
    expect(out).not.toContain('[Memory]');
    expect(out).not.toContain('KNOWN FACTS ABOUT THE USER');
  });

  it('frames the facts as the assistant\'s own knowledge, with a POSITIVE use-instruction', () => {
    // Positive ("the way a friend who remembers would") beat the negative "do not mention this list",
    // which models leak past. Keep both the framing and the positive instruction.
    const out = buildMemoryContext(['Works in sales']);
    expect(out).toMatch(/already know this person/i);
    expect(out).toContain('the way a friend who remembers would');
    expect(out).not.toMatch(/do not mention this list/i);
  });

  it('returns empty string for no facts, so callers inject nothing rather than an empty frame', () => {
    expect(buildMemoryContext([])).toBe('');
  });
});
