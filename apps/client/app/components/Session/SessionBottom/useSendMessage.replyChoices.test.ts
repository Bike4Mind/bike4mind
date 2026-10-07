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

  // A throw reaching handleSendClick's outer catch after `handler()` already posted the
  // message (quest adoption, cache migration, cleanup) must not be reported as a refusal -
  // ReplyChoiceButtons would otherwise drop a pick for a message that actually sent.
  it('only reports a refusal for a throw before the message was dispatched', () => {
    const dispatchCall = at('data = await handler(sessionToSend);');
    const dispatchedFlagSet = at('dispatchedRef.current = true;');
    const guardedOuterRefusal = at('if (!dispatchedRef.current) options?.onRefused?.();');
    expect(dispatchedFlagSet).toBeGreaterThan(dispatchCall);
    expect(guardedOuterRefusal).toBeGreaterThan(dispatchedFlagSet);
    // Reset per call so a later send doesn't inherit a stale `true` from an earlier one.
    expect(source).toMatch(/dispatchedRef\.current = false;\s*\n\s*if \(submittingRef\.current\) \{/);
  });
});
