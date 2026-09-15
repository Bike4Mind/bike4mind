import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Regression guard: the send-path validation must hand validateChatInput the active model id.
 *
 * Without it, a pin the catalog no longer serves (a session's `lastUsedModel`, or the persisted
 * llm-settings store, holding a model that has since been retired) is reported as "No AI model
 * selected" - which describes the wrong problem and points at a picker that looks healthy.
 *
 * A source-level assertion is used rather than a full renderHook because useSendMessage consumes
 * ~15 context providers; mirrors useSendMessage.stopMessageToast.test.ts.
 */
describe('useSendMessage - model id reaches input validation', () => {
  const source = readFileSync(resolve(__dirname, 'useSendMessage.ts'), 'utf8');
  const callMatch = source.match(/validateChatInput\(\{[\s\S]*?\}\);/);

  it('locates the validateChatInput call in the source', () => {
    expect(callMatch).not.toBeNull();
  });

  it('passes the active model so an unavailable pin can be named', () => {
    // Matches shorthand and any identifier, so renaming the local does not turn this red - the
    // property being bound to something real is the contract, not what that something is called.
    expect(callMatch?.[0] ?? '').toMatch(/selectedModel\s*(?::\s*(?!undefined|null)[A-Za-z_$][\w$.]*)?\s*[,}]/);
  });
});
