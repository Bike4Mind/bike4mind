import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Wiring guard: an agent-mode send must hand its deduped per-message attachments to both
 * the optimistic prompt bubble (so MessageContent fetches the attachment chip live) and the
 * dispatch (so the server records them on the prompt Quest). Source-level, like the sibling
 * `useSendMessage.routingComplexity.test.ts`: the hook pulls in too many providers to render.
 */
describe('useSendMessage - agent-mode attachments reach the bubble and the dispatch', () => {
  const source = readFileSync(resolve(__dirname, 'useSendMessage.ts'), 'utf8');

  it('passes the deduped message file ids to the optimistic bubble', () => {
    expect(source).toMatch(
      /createOptimisticPromptBubble\(\s*queryClient,\s*dispatchSessionId,\s*prompt,\s*routingSource,\s*dispatchMessageFileIds\s*\)/
    );
  });

  it('dispatches the same deduped ids as messageFileIds', () => {
    expect(source).toMatch(
      /messageFileIds:\s*dispatchMessageFileIds\.length > 0 \? dispatchMessageFileIds : undefined,/
    );
  });
});
