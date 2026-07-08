import { describe, it, expect, vi } from 'vitest';
import { bridgeToAsyncIterable, type EventSink } from './streamBridge';

/** Let the generator wire the producer and suspend before the producer pushes. */
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('bridgeToAsyncIterable', () => {
  it('yields pushed values in order, then returns on end()', async () => {
    let sink!: EventSink<number>;
    const gen = bridgeToAsyncIterable<number>(s => {
      sink = s;
    });
    const out: number[] = [];
    const consumer = (async () => {
      for await (const value of gen) out.push(value);
    })();

    await tick();
    sink.push(1);
    sink.push(2);
    sink.end();
    await consumer;

    expect(out).toEqual([1, 2]);
  });

  it('drains queued values, then throws the fail() error', async () => {
    let sink!: EventSink<number>;
    const gen = bridgeToAsyncIterable<number>(s => {
      sink = s;
    });
    const out: number[] = [];
    const consumer = (async () => {
      for await (const value of gen) out.push(value);
    })();

    await tick();
    sink.push(1);
    sink.fail(new Error('boom'));

    await expect(consumer).rejects.toThrow('boom');
    expect(out).toEqual([1]);
  });

  it('runs teardown once when iteration ends normally', async () => {
    const teardown = vi.fn();
    let sink!: EventSink<number>;
    const gen = bridgeToAsyncIterable<number>(s => {
      sink = s;
      return teardown;
    });
    const consumer = (async () => {
      for await (const _value of gen) void _value;
    })();

    await tick();
    sink.end();
    await consumer;

    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it('runs teardown when the consumer breaks early', async () => {
    const teardown = vi.fn();
    let sink!: EventSink<number>;
    const gen = bridgeToAsyncIterable<number>(s => {
      sink = s;
      return teardown;
    });
    const consumer = (async () => {
      for await (const _value of gen) {
        void _value;
        break;
      }
    })();

    await tick();
    sink.push(1);
    await consumer;

    expect(teardown).toHaveBeenCalledTimes(1);
  });
});
