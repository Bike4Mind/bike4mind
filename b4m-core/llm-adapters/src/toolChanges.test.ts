import { describe, it, expect } from 'vitest';
import { anthropicBetaHeader, PROMPT_CACHING_BETA, TOOL_CHANGES_BETA } from './toolChanges';

describe('anthropicBetaHeader', () => {
  it('is undefined when no beta applies', () => {
    expect(anthropicBetaHeader([false, false])).toBeUndefined();
  });

  it('keeps a single beta as it was', () => {
    expect(anthropicBetaHeader([PROMPT_CACHING_BETA, false])).toBe('prompt-caching-2024-07-31');
    expect(anthropicBetaHeader([false, TOOL_CHANGES_BETA])).toBe('mid-conversation-tool-changes-2026-07-01');
  });

  it('merges betas into one comma-joined value', () => {
    expect(anthropicBetaHeader([PROMPT_CACHING_BETA, TOOL_CHANGES_BETA])).toBe(
      'prompt-caching-2024-07-31,mid-conversation-tool-changes-2026-07-01'
    );
  });
});
