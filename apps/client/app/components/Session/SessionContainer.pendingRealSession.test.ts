import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * The stream gate (shouldAcceptStreamFrame) only adopts frames on a null/optimistic view from the
 * session recorded in `pendingRealSessionId`, so every place a first send learns its real session
 * must record it. Source-level, mirroring useSendMessage.rapidReplyReset.test.ts: SessionContainer
 * and useSendMessage each pull in too many providers to mount here.
 */
describe('pendingRealSessionId is recorded wherever a first send learns its session', () => {
  const container = readFileSync(resolve(__dirname, 'SessionContainer.tsx'), 'utf8');
  const sendMessage = readFileSync(resolve(__dirname, 'SessionBottom/useSendMessage.ts'), 'utf8');

  it('session.created records the real id before migrating and navigating off the tmpId', () => {
    const handler = container.slice(container.indexOf("subscribeToAction('session.created'"));
    const recordAt = handler.indexOf('pendingRealSessionId: realId');
    expect(recordAt).toBeGreaterThan(-1);
    expect(recordAt).toBeLessThan(handler.indexOf('migrateQuests(tmpId, realId)'));
    expect(recordAt).toBeLessThan(handler.indexOf('await navigate('));
  });

  it('useSendMessage records client-created sessions (data lake, agent executor)', () => {
    expect(sendMessage).toMatch(/pendingRealSessionId: dataLakeCreated\?\.id \?\? null/);
    expect(sendMessage).toMatch(/pendingRealSessionId: realSession\.id/);
  });
});
