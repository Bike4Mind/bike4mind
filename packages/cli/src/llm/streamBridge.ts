/**
 * Sink a push-based producer writes into. `push` queues a value, `end`
 * completes the stream, `fail` ends it with an error that the consumer throws.
 * All three are safe to call after settlement (extra calls are ignored by the
 * bridge's drain loop).
 */
export interface EventSink<T> {
  push(value: T): void;
  end(): void;
  fail(error: Error): void;
}

/**
 * Bridge a push-based producer (event emitters, parser callbacks) into a
 * pull-based async iterable - the shape both CLI transports need to feed
 * `runCompletion`. `wire` connects the producer to the sink and returns an
 * optional teardown run exactly once when iteration finishes (normal return, a
 * thrown failure, or the consumer breaking early). Values are yielded in push
 * order; `end()` returns, `fail(e)` throws `e` after draining what was queued.
 */
export async function* bridgeToAsyncIterable<T>(wire: (sink: EventSink<T>) => (() => void) | void): AsyncGenerator<T> {
  const queue: T[] = [];
  let ended = false;
  let failure: Error | undefined;
  let wake: (() => void) | undefined;

  const signalReady = () => {
    wake?.();
    wake = undefined;
  };

  const sink: EventSink<T> = {
    push: value => {
      queue.push(value);
      signalReady();
    },
    end: () => {
      ended = true;
      signalReady();
    },
    fail: error => {
      failure = error;
      ended = true;
      signalReady();
    },
  };

  const teardown = wire(sink);
  try {
    while (true) {
      while (queue.length > 0) yield queue.shift() as T;
      if (failure) throw failure;
      if (ended) return;
      await new Promise<void>(resolve => {
        wake = resolve;
      });
    }
  } finally {
    teardown?.();
  }
}
