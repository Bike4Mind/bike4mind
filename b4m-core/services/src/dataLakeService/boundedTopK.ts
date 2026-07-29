/**
 * Fixed-capacity best-N collector: keeps only the top `capacity` items ever offered, so peak
 * memory is O(capacity) rather than O(items). Lets a caller rank a corpus far larger than
 * memory by streaming it through in pages.
 *
 * Sorted-array insert rather than a heap: capacity here is a retrieval topK (tens, capped at
 * 100), where the O(capacity) splice is cheaper in practice than heap bookkeeping and the
 * ordering is directly inspectable. Revisit if capacity ever grows by orders of magnitude.
 *
 * `compare` must be a TOTAL order (no ties left to arrival order), otherwise the result depends
 * on the order pages happen to arrive and stops being reproducible.
 */
export class BoundedTopK<T> {
  private readonly items: T[] = [];

  constructor(
    private readonly capacity: number,
    private readonly compare: (a: T, b: T) => number
  ) {}

  /** O(1) reject once full and the item does not beat the current worst. */
  offer(item: T): void {
    if (this.capacity <= 0) return;
    const worst = this.items[this.items.length - 1];
    if (this.items.length >= this.capacity && worst !== undefined && this.compare(item, worst) >= 0) return;

    let lo = 0;
    let hi = this.items.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.compare(this.items[mid], item) <= 0) lo = mid + 1;
      else hi = mid;
    }
    this.items.splice(lo, 0, item);
    if (this.items.length > this.capacity) this.items.pop();
  }

  get size(): number {
    return this.items.length;
  }

  /** Best-first, per `compare`. The returned array is the live buffer - do not offer afterwards. */
  drain(): T[] {
    return this.items;
  }
}
