import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Source-level guard (same approach as useSendMessage.killSwitch.test.ts, since the hook
 * consumes many providers): the credit check is skipped only for the current walk step's
 * recorded prompt, and that decision is made on the prompt actually sent.
 */
describe('useSendMessage - recorded tutorial turn wiring', () => {
  const source = readFileSync(resolve(__dirname, 'useSendMessage.ts'), 'utf8');
  const normalized = source.replace(/\s+/g, ' ');

  it('passes the sent prompt through isRecordedTutorialTurn into validateChatInput', () => {
    expect(normalized).toContain('const errorMessage = validateChatInput({');
    expect(normalized).toContain('recordedTutorialTurn: isRecordedTutorialTurn(prompt),');
  });
});
