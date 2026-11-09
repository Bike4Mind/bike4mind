/** Per stream. The model pays for this text on every later turn, the endpoint being stateless. */
export const MAX_STREAM_BYTES = 40_000;

/** Same split as capOutputMiddle: the end of a command's output carries its errors, summary and URLs. */
const HEAD_SHARE = 0.25;

/** Small chunks are merged past this count, so trimming the tail never walks a long array. */
const MAX_TAIL_CHUNKS = 64;

/**
 * Collects one stream within a byte ceiling, keeping its start and its end and dropping the
 * middle. Bytes are kept raw and decoded only on read, so a multi-byte character split across
 * chunks decodes intact, and a cut inside one drops that character rather than mangling it.
 */
export class CappedOutput {
  private readonly headLimit: number;
  private readonly tailLimit: number;
  private head: Buffer | null = null;
  private headBytes = 0;
  private tail: Buffer[] = [];
  private tailBytes = 0;
  private dropped = 0;

  constructor(maxBytes = MAX_STREAM_BYTES) {
    this.headLimit = Math.floor(maxBytes * HEAD_SHARE);
    this.tailLimit = maxBytes - this.headLimit;
  }

  push(chunk: Buffer): void {
    let rest = chunk;
    if (this.headBytes < this.headLimit) {
      this.head ??= Buffer.allocUnsafe(this.headLimit);
      const taken = Math.min(rest.length, this.headLimit - this.headBytes);
      rest.copy(this.head, this.headBytes, 0, taken);
      this.headBytes += taken;
      rest = rest.subarray(taken);
    }
    if (rest.length === 0) return;

    if (rest.length >= this.tailLimit) {
      this.dropped += this.tailBytes + rest.length - this.tailLimit;
      // A copy, so the tail does not pin the whole chunk it was cut from.
      this.tail = [Buffer.from(rest.subarray(rest.length - this.tailLimit))];
      this.tailBytes = this.tailLimit;
      return;
    }
    this.tail.push(rest);
    this.tailBytes += rest.length;
    if (this.tail.length > MAX_TAIL_CHUNKS) this.tail = [Buffer.concat(this.tail)];
    let first = 0;
    while (this.tailBytes - this.tail[first].length >= this.tailLimit) {
      this.tailBytes -= this.tail[first].length;
      this.dropped += this.tail[first].length;
      first += 1;
    }
    if (first > 0) this.tail = this.tail.slice(first);
    const excess = this.tailBytes - this.tailLimit;
    if (excess > 0) {
      this.tail[0] = this.tail[0].subarray(excess);
      this.tailBytes -= excess;
      this.dropped += excess;
    }
  }

  toString(): string {
    const head = this.head ? this.head.subarray(0, this.headBytes) : Buffer.alloc(0);
    const tail = Buffer.concat(this.tail, this.tailBytes);
    if (this.dropped === 0) return Buffer.concat([head, tail]).toString('utf8');
    const keptHead = withoutPartialEnd(head);
    const keptTail = withoutPartialStart(tail);
    const omitted = this.dropped + (head.length - keptHead.length) + (tail.length - keptTail.length);
    return `${keptHead.toString('utf8')}\n[... ${omitted} bytes omitted from the middle ...]\n${keptTail.toString('utf8')}`;
  }
}

function isContinuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

function withoutPartialEnd(bytes: Buffer): Buffer {
  let lead = bytes.length - 1;
  while (lead >= 0 && lead > bytes.length - 4 && isContinuation(bytes[lead])) lead -= 1;
  if (lead < 0) return bytes;
  const byte = bytes[lead];
  const width = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
  return bytes.length - lead < width ? bytes.subarray(0, lead) : bytes;
}

function withoutPartialStart(bytes: Buffer): Buffer {
  let start = 0;
  while (start < 3 && start < bytes.length && isContinuation(bytes[start])) start += 1;
  return bytes.subarray(start);
}
