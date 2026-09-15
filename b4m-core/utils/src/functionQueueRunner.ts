import { Logger } from '@bike4mind/observability';
const DEFAULT_INTERVAL = 1000;

/**
 * A class that runs a queue of functions at a given interval.
 *
 * @example
 * const runner = new FunctionQueueRunner(1000);
 * runner.add(async () => {
 *   console.log('Hello, world!');
 * });
 */
class FunctionQueueRunner {
  private interval: number;
  private queue: (() => Promise<void>)[];
  private intervalId?: NodeJS.Timeout;

  constructor(interval: number = DEFAULT_INTERVAL) {
    this.interval = interval;
    this.queue = [];
    this.run();
  }

  add(fn: () => Promise<void>) {
    this.queue.push(fn);
  }

  /**
   * Closes the queue runner and waits for all functions to complete.
   */
  async close() {
    clearInterval(this.intervalId);

    while (this.queue.length > 0) {
      const fn = this.queue.shift();
      if (fn) {
        await fn();
        await new Promise(resolve => setTimeout(resolve, this.interval / 2));
      }
    }
  }

  private run() {
    this.intervalId = setInterval(async () => {
      const fn = this.queue.shift();
      if (fn) {
        try {
          await fn();
        } catch (error) {
          Logger.globalInstance.log('Error running function', error);
        }
      }
    }, this.interval);
  }
}

export default FunctionQueueRunner;
export { FunctionQueueRunner };
