import { describe, it, expect } from 'vitest';
import { validateChatInput } from './validateChatInput';

const baseParams = {
  inputText: 'Hello world',
  accessibleModels: [{ id: 'gpt-4o' as const }],
  maxInputTokens: 10000,
  effectiveMaxOutputTokens: 4096,
  currentUser: { currentCredits: 100 },
  effectiveCredits: 100,
  enforceCredits: false,
};

describe('validateChatInput', () => {
  it('returns null for valid input', () => {
    expect(validateChatInput(baseParams)).toBeNull();
  });

  describe('model access check', () => {
    it('returns error when accessibleModels is undefined (still loading)', () => {
      const result = validateChatInput({ ...baseParams, accessibleModels: undefined });
      expect(result).toMatch(/don't have access to any AI models/i);
    });

    it('returns error when accessibleModels is empty', () => {
      const result = validateChatInput({ ...baseParams, accessibleModels: [] });
      expect(result).toMatch(/don't have access to any AI models/i);
    });

    it('returns null when at least one model is accessible', () => {
      const result = validateChatInput({ ...baseParams, accessibleModels: [{ id: 'claude-3-5-sonnet' as const }] });
      expect(result).toBeNull();
    });
  });

  describe('no-model check', () => {
    it('returns "no model selected" when maxInputTokens is 0', () => {
      const result = validateChatInput({ ...baseParams, maxInputTokens: 0 });
      expect(result).toMatch(/no ai model selected/i);
    });

    it('returns "no model selected" when maxInputTokens is negative (defensive)', () => {
      const result = validateChatInput({ ...baseParams, maxInputTokens: -1 });
      expect(result).toMatch(/no ai model selected/i);
    });

    it('does not surface the misleading "exceeds maximum (0 tokens)" message', () => {
      const result = validateChatInput({ ...baseParams, maxInputTokens: 0 });
      expect(result).not.toMatch(/exceeds maximum/i);
    });

    // A pin that outlived its model reads as "you didn't pick one", which sends the user to a picker
    // that already looks fine and hides the fact that the id has to be REPLACED. The catalog is known
    // loaded here - the accessibleModels branch above already rejected an empty one - so an id that
    // yields no context window is genuinely gone, not still in flight.
    it('names the model when the selected one is no longer in the catalog', () => {
      const result = validateChatInput({
        ...baseParams,
        maxInputTokens: 0,
        selectedModel: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
      });
      expect(result).toMatch(/us\.anthropic\.claude-sonnet-4-5-20250929-v1:0/);
      expect(result).toMatch(/no longer available/i);
    });

    it('still says "no model selected" when nothing is selected at all', () => {
      const result = validateChatInput({ ...baseParams, maxInputTokens: 0, selectedModel: '' });
      expect(result).toMatch(/no ai model selected/i);
    });
  });

  describe('input length check', () => {
    it('returns error when input exceeds maxInputTokens', () => {
      const result = validateChatInput({ ...baseParams, inputText: 'x'.repeat(10001), maxInputTokens: 10000 });
      expect(result).toMatch(/exceeds maximum/i);
    });

    it('returns null when input is exactly at the limit', () => {
      const result = validateChatInput({ ...baseParams, inputText: 'x'.repeat(10000), maxInputTokens: 10000 });
      expect(result).toBeNull();
    });
  });

  describe('empty input check', () => {
    it('returns error for empty string', () => {
      const result = validateChatInput({ ...baseParams, inputText: '' });
      expect(result).toMatch(/empty message/i);
    });

    it('returns error for whitespace-only input', () => {
      const result = validateChatInput({ ...baseParams, inputText: '   ' });
      expect(result).toMatch(/empty message/i);
    });
  });

  describe('user check', () => {
    it('returns error when currentUser is null', () => {
      const result = validateChatInput({ ...baseParams, currentUser: null });
      expect(result).toMatch(/user data not available/i);
    });
  });

  describe('credits check', () => {
    it('returns error when out of credits and enforceCredits is on', () => {
      const result = validateChatInput({ ...baseParams, effectiveCredits: 0, enforceCredits: true });
      expect(result).toMatch(/out of credits/i);
    });

    it('returns null when out of credits but enforceCredits is off', () => {
      const result = validateChatInput({ ...baseParams, effectiveCredits: 0, enforceCredits: false });
      expect(result).toBeNull();
    });

    it('returns null with negative credits when enforceCredits is off', () => {
      const result = validateChatInput({ ...baseParams, effectiveCredits: -5, enforceCredits: false });
      expect(result).toBeNull();
    });

    it('prompts to verify email when an unverified open-signup user is out of credits', () => {
      const result = validateChatInput({
        ...baseParams,
        effectiveCredits: 0,
        enforceCredits: true,
        currentUser: { currentCredits: 0, emailVerified: false, tags: ['Customer', 'pending-free-credits'] },
      });
      expect(result).toMatch(/verify your email to unlock your free credits/i);
      expect(result).not.toMatch(/out of credits/i);
    });

    it('shows generic out-of-credits once the open-signup user has verified', () => {
      const result = validateChatInput({
        ...baseParams,
        effectiveCredits: 0,
        enforceCredits: true,
        currentUser: { currentCredits: 0, emailVerified: true, tags: ['Customer', 'pending-free-credits'] },
      });
      expect(result).toMatch(/out of credits/i);
    });

    it('shows generic out-of-credits for an unverified user without the pending-credits tag', () => {
      const result = validateChatInput({
        ...baseParams,
        effectiveCredits: 0,
        enforceCredits: true,
        currentUser: { currentCredits: 0, emailVerified: false, tags: ['Customer'] },
      });
      expect(result).toMatch(/out of credits/i);
    });
  });

  describe('validation priority order', () => {
    it('reports model access error before checking empty input', () => {
      const result = validateChatInput({ ...baseParams, accessibleModels: [], inputText: '' });
      expect(result).toMatch(/don't have access to any AI models/i);
    });

    it('reports token limit error before checking empty input', () => {
      // A long string of spaces: exceeds token limit but is whitespace-only
      const result = validateChatInput({
        ...baseParams,
        inputText: ' '.repeat(10001),
        maxInputTokens: 10000,
      });
      expect(result).toMatch(/exceeds maximum/i);
    });
  });
});
