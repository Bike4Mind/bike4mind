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

  // First settlement wins (promise-like): once ended, further push/end/fail are
  // ignored. This is what makes a post-terminal socket error benign - e.g. an SSE
  // stream that emits `[DONE]` (end) then errors during teardown must NOT turn a
  // delivered turn into a thrown error (which the core would retry -> double-bill).
  const sink: EventSink<T> = {
    push: value => {
      if (ended) return;
      queue.push(value);
      signalReady();
    },
    end: () => {
      if (ended) return;
      ended = true;
      signalReady();
    },
    fail: error => {
      if (ended) return;
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
