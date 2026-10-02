import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * A typed bare key picks an option of the newest reply. The expansion itself is unit-tested as
 * expandChoiceKey in @bike4mind/common; this locks how the hook wires it, source-level for the
 * same reason as `useSendMessage.agentMode.test.ts`.
 */
describe('useSendMessage - typed reply-choice keys', () => {
  const source = readFileSync(resolve(__dirname, 'useSendMessage.ts'), 'utf8');
  const at = (needle: string) => {
    const index = source.indexOf(needle);
    expect(index, needle).toBeGreaterThan(-1);
    return index;
  };

  it('expands editor sends only, never a programmatic prompt', () => {
    expect(source).toContain(
      'newPrompt === undefined ? expandChoiceKey(typedPrompt, newestTurn?.suggestedChoices) : null'
    );
  });

  it('validates and sends the expanded text, not the bare key', () => {
    expect(at('const prompt = choiceKey?.prompt ?? typedPrompt;')).toBeLessThan(at('inputText: prompt,'));
  });

  it('records the pick only after validation has let the send through', () => {
    const validationReturn = at('if (errorMessage) {');
    expect(at('void recordReplyChoice(queryClient, {')).toBeGreaterThan(validationReturn);
  });

  // ReplyChoiceButtons records a click only when sendPrompt resolves true, which it does unless
  // onRefused fired (SessionBottom's sendPromptCallback).
  it('reports a send refused while another is in flight or by validation', () => {
    expect(source).toMatch(/if \(submittingRef\.current\) \{\s*options\?\.onRefused\?\.\(\);\s*return;/);
    expect(source).toMatch(/toast\.error\(errorMessage\);\s*setSubmitting\(false\);\s*options\?\.onRefused\?\.\(\);/);
  });
});
