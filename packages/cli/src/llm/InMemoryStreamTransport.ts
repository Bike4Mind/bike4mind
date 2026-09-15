import type { StreamEvent } from './streamEvents';
import type { CompletionRequest, StreamTransport } from './streamTransport';

/**
 * One scripted step for {@link InMemoryStreamTransport}:
 * - `emit`  - yield a decoded stream event to the core;
 * - `fail`  - throw, simulating a wire failure (feeds the retry policy);
 * - `abort` - abort the linked controller, simulating a mid-stream user cancel.
 */
export type ScriptedStep = { emit: StreamEvent } | { fail: Error } | { abort: true };

/**
 * In-memory {@link StreamTransport} test double. It scripts the exact events (or
 * failure) of each `open()` attempt so `runCompletion` can be driven end-to-end
 * with no real SSE or WebSocket - the "in-memory adapter" the ports & adapters
 * design calls for.
 *
 * `scripts` is one step-list per attempt: attempt 0 runs `scripts[0]`, the first
 * retry runs `scripts[1]`, and so on. Once attempts exceed the scripted count
 * the LAST script repeats, so a single failing script models "fails every
 * attempt", while `[[fail], [emit...]]` models "fails once, then succeeds".
 */
export class InMemoryStreamTransport implements StreamTransport {
  /** Number of times `open()` has been called - lets tests assert attempt count. */
  public attempts = 0;
  /** The request passed to each `open()` call, in order. */
  public readonly requests: CompletionRequest[] = [];

  /**
   * @param scripts    Per-attempt step lists (see class docs).
   * @param controller Optional controller an `abort` step trips, so a test can
   *                   abort mid-stream deterministically without racing timers.
   */
  constructor(
    private readonly scripts: ScriptedStep[][],
    private readonly controller?: AbortController
  ) {}

  open(req: CompletionRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const attempt = this.attempts++;
    this.requests.push(req);
    const script = this.scripts[Math.min(attempt, this.scripts.length - 1)] ?? [];
    const controller = this.controller;

    return (async function* () {
      for (const step of script) {
        // A prior abort ends the stream promptly, matching a real transport
        // that tears down its socket the moment the caller cancels.
        if (signal?.aborted) return;
        if ('abort' in step) {
          controller?.abort();
          return;
        }
        if ('fail' in step) throw step.fail;
        yield step.emit;
      }
    })();
  }
}
