import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Regression guard: the composer's blocked-send gate (sendBlockedReason) must apply to
// ReplyChoiceButtons' picks but never to programmatic callers like InteractiveChessBoard, which
// share the same registered sendPrompt (see sendPromptViaComposer.test.ts for the gate's own
// behavior, and InteractiveChessBoard.test.tsx for the chess-side revert). A full SessionBottom
// render requires a large web of context providers that adds little signal beyond locking this
// invariant, so this is source-level (mirrors SessionBottom.dedup.test.ts).
describe('SessionBottom - blocked-send gate is scoped to reply-choice sends', () => {
  const source = readFileSync(resolve(__dirname, 'SessionBottom.tsx'), 'utf8');

  it('handleEditorSubmit always gates (unconditional sendBlockedReason)', () => {
    const handleEditorSubmit = source.slice(
      source.indexOf('const handleEditorSubmit ='),
      source.indexOf('const sendPromptCallback =')
    );
    expect(handleEditorSubmit).toMatch(/sendPromptViaComposer\(\{\s*sendBlockedReason,/);
  });

  it('sendPromptCallback gates only when the caller opts in via respectBlockedState', () => {
    const sendPromptCallback = source.slice(source.indexOf('const sendPromptCallback ='));
    expect(sendPromptCallback).toContain('sendBlockedReason: options?.respectBlockedState ? sendBlockedReason : null,');
  });
});
