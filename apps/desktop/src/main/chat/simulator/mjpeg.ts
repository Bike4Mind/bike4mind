const HEADER_END = Buffer.from('\r\n\r\n');
const LENGTH = /content-length:\s*(\d+)/i;
/** A part header larger than this is not a header; drop it rather than buffer forever. */
const MAX_HEADER_BYTES = 4096;

/**
 * Splits AXe's `stream-video --format mjpeg` output (an HTTP multipart/x-mixed-replace body) into
 * JPEG frames, using each part's Content-Length. Fed chunks as stdout delivers them.
 */
export class MjpegParser {
  private buffer: Buffer = Buffer.alloc(0);
  private pending: number | null = null;

  constructor(private readonly onFrame: (jpeg: Buffer) => void) {}

  push(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      if (this.pending === null) {
        const end = this.buffer.indexOf(HEADER_END);
        if (end < 0) {
          if (this.buffer.length > MAX_HEADER_BYTES) this.buffer = this.buffer.subarray(-HEADER_END.length);
          return;
        }
        const header = this.buffer.subarray(0, end).toString('latin1');
        this.buffer = this.buffer.subarray(end + HEADER_END.length);
        const length = LENGTH.exec(header);
        // The stream's own HTTP status block and blank boundaries carry no length.
        if (length) this.pending = Number(length[1]);
        continue;
      }
      if (this.buffer.length < this.pending) return;
      const frame = Buffer.from(this.buffer.subarray(0, this.pending));
      this.buffer = this.buffer.subarray(this.pending);
      this.pending = null;
      this.onFrame(frame);
    }
  }
}
