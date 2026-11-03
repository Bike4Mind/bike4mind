import { describe, expect, it } from 'vitest';
import { createSubagentTextDeltaSender } from './agentExecutor.subagentTextDelta';

type Sent = { childExecutionId: string; delta: string };

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(r => {
    resolve = r;
  });
  return { promise, resolve };
};

describe('createSubagentTextDeltaSender', () => {
  it('delivers deltas in call order even when an earlier send resolves later', async () => {
    const gates = [deferred(), deferred(), deferred()];
    const started: string[] = [];
    const delivered: string[] = [];
    let call = 0;
    const sendFrame = async ({ delta }: Sent) => {
      const gate = gates[call++];
      started.push(delta);
      await gate.promise;
      delivered.push(delta);
    };
    const { send } = createSubagentTextDeltaSender(sendFrame, 100);
    const base = { agentName: 'researcher', iteration: 1 };

    const p1 = send({ ...base, childExecutionId: 'c1', delta: 'I ' });
    const p2 = send({ ...base, childExecutionId: 'c1', delta: 'appreciate ' });
    const p3 = send({ ...base, childExecutionId: 'c1', delta: 'your patience' });

    await Promise.resolve();
    expect(started).toEqual(['I ']);

    gates[0].resolve();
    await p1;
    gates[1].resolve();
    await p2;
    gates[2].resolve();
    await p3;

    expect(delivered).toEqual(['I ', 'appreciate ', 'your patience']);
  });

  it('does not serialize different children against each other', async () => {
    const gate = deferred();
    const started: string[] = [];
    const sendFrame = async ({ childExecutionId }: Sent) => {
      started.push(childExecutionId);
      if (childExecutionId === 'slow') await gate.promise;
    };
    const { send } = createSubagentTextDeltaSender(sendFrame, 100);
    const base = { agentName: 'a', iteration: 1, delta: 'x' };

    const slow = send({ ...base, childExecutionId: 'slow' });
    await send({ ...base, childExecutionId: 'fast' });

    expect(started).toEqual(['slow', 'fast']);
    gate.resolve();
    await slow;
  });

  it('splits an oversized delta into ordered chunks', async () => {
    const delivered: string[] = [];
    const { send } = createSubagentTextDeltaSender(async ({ delta }) => {
      delivered.push(delta);
    }, 3);

    await send({ childExecutionId: 'c1', agentName: 'a', iteration: 0, delta: 'abcdefgh' });

    expect(delivered).toEqual(['abc', 'def', 'gh']);
  });

  it('keeps later deltas flowing after a send fails, and surfaces the failure to its own caller', async () => {
    const delivered: string[] = [];
    const sendFrame = async ({ delta }: Sent) => {
      if (delta === 'bad') throw new Error('gone');
      delivered.push(delta);
    };
    const { send } = createSubagentTextDeltaSender(sendFrame, 100);
    const base = { childExecutionId: 'c1', agentName: 'a', iteration: 1 };

    const failing = send({ ...base, delta: 'bad' });
    const next = send({ ...base, delta: 'ok' });

    await expect(failing).rejects.toThrow('gone');
    await next;
    expect(delivered).toEqual(['ok']);
  });

  it('sends no frames for an empty delta and no empty trailing chunk for an exact multiple', async () => {
    const delivered: string[] = [];
    const { send } = createSubagentTextDeltaSender(async ({ delta }) => {
      delivered.push(delta);
    }, 3);
    const base = { childExecutionId: 'c1', agentName: 'a', iteration: 0 };

    await send({ ...base, delta: '' });
    await send({ ...base, delta: 'abcdef' });

    expect(delivered).toEqual(['abc', 'def']);
  });

  it('keeps a later send queued behind an in-flight one after an earlier link settles', async () => {
    const gates = [deferred(), deferred(), deferred()];
    const started: string[] = [];
    let call = 0;
    const { send, flush } = createSubagentTextDeltaSender(async ({ delta }) => {
      const gate = gates[call++];
      started.push(delta);
      await gate.promise;
    }, 100);
    const base = { childExecutionId: 'c1', agentName: 'a', iteration: 1 };

    const p1 = send({ ...base, delta: 'A' });
    const p2 = send({ ...base, delta: 'B' });
    gates[0].resolve();
    await p1;
    for (let tick = 0; tick < 5; tick++) await Promise.resolve();

    const p3 = send({ ...base, delta: 'C' });
    let flushed = false;
    const flushing = flush('c1').then(() => {
      flushed = true;
    });
    for (let tick = 0; tick < 5; tick++) await Promise.resolve();

    expect(started).toEqual(['A', 'B']);
    expect(flushed).toBe(false);

    gates[1].resolve();
    await p2;
    gates[2].resolve();
    await Promise.all([p3, flushing]);
    expect(started).toEqual(['A', 'B', 'C']);
  });

  describe('flush', () => {
    it('resolves only after every queued delta for that child has been sent', async () => {
      const gate = deferred();
      const delivered: string[] = [];
      const { send, flush } = createSubagentTextDeltaSender(async ({ delta }) => {
        await gate.promise;
        delivered.push(delta);
      }, 100);
      const base = { childExecutionId: 'c1', agentName: 'a', iteration: 1 };

      void send({ ...base, delta: 'one' });
      void send({ ...base, delta: 'two' });
      let flushed = false;
      const flushing = flush('c1').then(() => {
        flushed = true;
      });

      await Promise.resolve();
      expect(flushed).toBe(false);

      gate.resolve();
      await flushing;
      expect(delivered).toEqual(['one', 'two']);
    });

    it('resolves immediately for a child with nothing queued', async () => {
      const { flush } = createSubagentTextDeltaSender(async () => {}, 100);
      await expect(flush('unknown')).resolves.toBeUndefined();
    });

    it('does not reject when a queued send failed', async () => {
      const { send, flush } = createSubagentTextDeltaSender(async () => {
        throw new Error('gone');
      }, 100);

      const failing = send({ childExecutionId: 'c1', agentName: 'a', iteration: 1, delta: 'x' });
      failing.catch(() => {});

      await expect(flush('c1')).resolves.toBeUndefined();
    });
  });
});
