/** A token bucket: `capacity` requests at once, refilled at `perSecond`. */
export class TokenBucket {
  #tokens: number;
  #last: number;

  constructor(
    readonly capacity: number,
    readonly perSecond: number,
    private readonly now: () => number = () => performance.now()
  ) {
    this.#tokens = capacity;
    this.#last = now();
  }

  #refill(): void {
    const now = this.now();
    this.#tokens = Math.min(this.capacity, this.#tokens + (Math.max(0, now - this.#last) / 1000) * this.perSecond);
    this.#last = now;
  }

  take(): boolean {
    this.#refill();
    if (this.#tokens < 1) return false;
    this.#tokens -= 1;
    return true;
  }

  /** Whole seconds until the next request would be let through. */
  retryAfterSeconds(): number {
    this.#refill();
    return Math.max(1, Math.ceil((1 - this.#tokens) / this.perSecond));
  }
}
