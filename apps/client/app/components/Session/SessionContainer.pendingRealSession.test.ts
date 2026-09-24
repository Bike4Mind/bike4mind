import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * The stream gate (shouldAcceptStreamFrame) only adopts frames on a null/optimistic view from the
 * session recorded in `pendingRealSessionId`, so every place a first send learns its real session
 * must record it. Source-level, mirroring useSendMessage.rapidReplyReset.test.ts: useSendMessage
 * pulls in too many providers to mount here. The session.created side is covered behaviourally
 * in hooks/__tests__/applySessionCreated.test.ts.
 */
describe('pendingRealSessionId is recorded wherever a first send learns its session', () => {
  const sendMessage = readFileSync(resolve(__dirname, 'SessionBottom/useSendMessage.ts'), 'utf8');

  it('useSendMessage records client-created sessions (data lake, agent executor)', () => {
    expect(sendMessage).toMatch(/pendingRealSessionId: dataLakeCreated\?\.id \?\? null/);
    expect(sendMessage).toMatch(/pendingRealSessionId: realSession\.id/);
  });
});
