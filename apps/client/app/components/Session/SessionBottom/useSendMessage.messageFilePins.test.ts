import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Wiring guard: every send tells the server which attachments are message-only (the rest are
 * pinned to the session), and mirrors the pin into the workbench once the send lands, so a later
 * full-list knowledgeIds write from this client keeps the file. Source-level, like the sibling
 * `useSendMessage.agentAttachments.test.ts`: the hook pulls in too many providers to render.
 */
describe('useSendMessage - message attachments pinned to the session', () => {
  const source = readFileSync(resolve(__dirname, 'useSendMessage.ts'), 'utf8');

  it.each(['return await handleCommand(commandHandlers,', 'return await handleLLMCommand({'])(
    'forwards the message-only ids on %s',
    opener => {
      const start = source.indexOf(opener);
      expect(start).toBeGreaterThan(-1);
      expect(source.slice(start, source.indexOf('});', start))).toMatch(
        /^\s*messageOnlyFileIds: sentMessageOnlyFileIds,\s*$/m
      );
    }
  );

  it('forwards the message-only ids on the agent dispatch', () => {
    expect(source).toMatch(
      /messageOnlyFileIds:\s*sentMessageOnlyFileIds\.length > 0 \? sentMessageOnlyFileIds : undefined,/
    );
  });

  it('mirrors the pin on both paths once the send lands', () => {
    expect(source).toMatch(/mirrorPinnedMessageFiles\(dispatchSessionId\);/);
    expect(source).toMatch(
      /dispatchedRef\.current = true;[\s\S]{0,200}mirrorPinnedMessageFiles\(data\?\.session\?\.id\)/
    );
  });
});
