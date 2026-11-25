import { beforeEach, describe, expect, it } from 'vitest';
import { devLog } from '../devlog/DevLogSink';
import { logDownstream } from './devLogDownstream';

describe('logDownstream', () => {
  beforeEach(() => devLog.clear());

  it('keeps a failed turn as an errors record with no window attached', () => {
    logDownstream('chat:event', {
      type: 'error',
      sessionId: 's1',
      messageId: 'm1',
      message: 'Model provider returned an error (upstream 502)',
      stopReason: 'credentials',
    });
    const [record] = devLog.snapshot().records;
    expect(record.tags).toEqual(['chat-stream', 'errors']);
    expect(record.message).toContain('Model provider returned an error (upstream 502)');
    expect(record.fields).toMatchObject({ source: 'reply', session: 's1', messageId: 'm1', stopReason: 'credentials' });
  });

  it('redacts a credential in the error text', () => {
    logDownstream('chat:event', { type: 'error', message: 'rejected: Bearer abcdefghijklmnop1234567890' });
    expect(devLog.snapshot().records[0].message).not.toContain('abcdefghijklmnop');
  });

  it('does not tag or retain an ordinary delta while nothing is watching', () => {
    logDownstream('chat:event', { type: 'delta', text: 'hi' });
    expect(devLog.snapshot().records).toHaveLength(0);
    const detach = devLog.attach(() => undefined);
    logDownstream('chat:event', { type: 'delta', text: 'hi' });
    detach();
    expect(devLog.snapshot().records[0].tags).toEqual(['chat-stream']);
  });
});
