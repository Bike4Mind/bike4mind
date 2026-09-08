import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Regression guards for the chat composer's update storm.
 *
 * lexical-beautiful-mentions' lookup effect keys on `items` and answers with
 * setResults([]) - a fresh array React can never bail out on - so an unstable
 * `items` schedules an un-bailable update on every render and keeps React's
 * cumulative nested-update chain from settling until an unrelated setState trips
 * "Maximum update depth exceeded". Re-inlining any link in the memo chain is a
 * one-character regression that silently restores the bug, which is what these
 * assert against.
 *
 * Source-level assertions are used (rather than a render) because SessionBottom
 * needs a large web of context providers that adds little signal beyond locking
 * these invariants, and because identity stability is precisely what a render
 * asserts poorly. Mirrors SessionBottom.dedup.test.ts.
 */
describe('chat composer - prop identity stability (regression)', () => {
  const sessionBottom = readFileSync(resolve(__dirname, 'SessionBottom.tsx'), 'utf8');
  const lexicalChatInput = readFileSync(resolve(__dirname, '../LexicalChatInput.tsx'), 'utf8');
  const useSendMessage = readFileSync(resolve(__dirname, 'useSendMessage.ts'), 'utf8');

  describe('SessionBottom', () => {
    it('builds lexicalAgents through useMemo', () => {
      expect(sessionBottom).toMatch(/const lexicalAgents = useMemo\(/);
    });

    it('does not default useGetAgents to a fresh array literal', () => {
      // `= []` mints a new array every render until the query resolves, which is
      // exactly the window (first typing on a cold page) the memo has to cover.
      expect(sessionBottom).toContain('const { data: availableAgents } = useGetAgents();');
      expect(sessionBottom).not.toMatch(/data: availableAgents = \[\]/);
    });

    it('passes memoized handlers to the composer rather than inline arrows', () => {
      expect(sessionBottom).toContain('onChange={handleInputChange}');
      expect(sessionBottom).toContain('onSubmit={handleEditorSubmit}');
      expect(sessionBottom).toMatch(/const handleInputChange = useCallback\(/);
      expect(sessionBottom).toMatch(/const handleEditorSubmit = useCallback\(/);
    });
  });

  describe('LexicalChatInput', () => {
    it('passes a memoized items object to the mentions plugin', () => {
      expect(lexicalChatInput).toContain('items={mentionItems}');
      expect(lexicalChatInput).toMatch(/const mentionItems = useMemo\(/);
    });

    it('passes a module-level transformers array to MarkdownShortcutPlugin', () => {
      expect(lexicalChatInput).toContain('transformers={MARKDOWN_SHORTCUT_TRANSFORMERS}');
      expect(lexicalChatInput).toMatch(/^const MARKDOWN_SHORTCUT_TRANSFORMERS = /m);
    });

    it('passes a stable callback to EditorRefPlugin', () => {
      expect(lexicalChatInput).toContain('onRef={handleEditorRef}');
      expect(lexicalChatInput).toMatch(/const handleEditorRef = useCallback\(/);
    });
  });

  describe('useSendMessage', () => {
    it('exports a handleSendClick that is stable across renders', () => {
      // Consumers (SubmitOnEnterPlugin, the useChatActions registration) key
      // lexical/zustand registrations on this identity, so a bare `async () => {}`
      // in the hook body re-registers on every render and defeats every
      // useCallback downstream of it.
      const declaration = useSendMessage.match(/const handleSendClick = useCallback\([\s\S]*?\n {4}\[\]\n {2}\);/);
      expect(declaration).not.toBeNull();
    });

    it('routes the send body through the submit mutex', () => {
      expect(useSendMessage).toContain('withSubmitMutex(submittingRef, setSubmittingState');
      expect(useSendMessage).toMatch(/const runSendClick = async \(/);
    });
  });

  it('rolls back the optimistic Stop affordance before the other state writes', () => {
    // Ordering invariant: a throw in setWorkBenchAgents/setSubmitting must not
    // skip the rollback, or `completed: false` plus the generating sentinel keeps
    // shouldShowStopButton true and the composer renders Stop forever - a latch
    // that releasing the submit mutex cannot undo.
    const catchBody = useSendMessage.match(/data = await handler\(sessionToSend\);[\s\S]*?\n {6}return;/);
    expect(catchBody).not.toBeNull();
    const body = catchBody?.[0] ?? '';

    const rollbackIdx = body.indexOf('setChatCompletion(prev =>');
    const submittingIdx = body.indexOf('setSubmitting(false)');
    const workBenchIdx = body.indexOf('setWorkBenchAgents([])');

    expect(rollbackIdx).toBeGreaterThan(-1);
    expect(rollbackIdx).toBeLessThan(workBenchIdx);
    expect(rollbackIdx).toBeLessThan(submittingIdx);
  });
});
