import { open } from 'node:fs/promises';

const READ_CHUNK = 256 * 1024;
const NEWLINE = 0x0a;

export interface JsonlLine {
  /** Null when the line was longer than the cap and was skipped unread. */
  text: string | null;
  /** Byte offset just past this line's newline: where a later read resumes. */
  end: number;
}

/**
 * Complete lines from `offset` on, read in fixed chunks so a multi-MB transcript is never one
 * string. A final line with no newline yet is left unread: Claude Code may still be writing it,
 * and resuming from the last `end` picks it up once it is whole.
 */
export async function* readJsonlLines(path: string, offset: number, maxLineBytes: number): AsyncGenerator<JsonlLine> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(READ_CHUNK);
    let position = offset;
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let skipping = false;

    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, READ_CHUNK, position);
      if (bytesRead === 0) return;
      let lineStart = 0;
      for (let index = 0; index < bytesRead; index++) {
        if (buffer[index] !== NEWLINE) continue;
        const end = position + index + 1;
        if (skipping || pendingBytes + index - lineStart > maxLineBytes) {
          yield { text: null, end };
        } else {
          const piece = buffer.subarray(lineStart, index);
          const text =
            pending.length === 0 ? piece.toString('utf8') : Buffer.concat([...pending, piece]).toString('utf8');
          yield { text, end };
        }
        pending = [];
        pendingBytes = 0;
        skipping = false;
        lineStart = index + 1;
      }
      if (lineStart < bytesRead && !skipping) {
        pendingBytes += bytesRead - lineStart;
        if (pendingBytes > maxLineBytes) {
          skipping = true;
          pending = [];
        } else {
          pending.push(Buffer.from(buffer.subarray(lineStart, bytesRead)));
        }
      }
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
}

/** The first `bytes` of a file and the last `bytes`, for indexing without a full read. */
export async function readHeadAndTail(
  path: string,
  size: number,
  bytes: number
): Promise<{ head: string[]; tail: string[] }> {
  const handle = await open(path, 'r');
  try {
    const headLength = Math.min(size, bytes);
    const headBuffer = Buffer.alloc(headLength);
    await handle.read(headBuffer, 0, headLength, 0);
    const head = completeLines(headBuffer, headLength === size);
    if (size <= bytes) return { head, tail: [] };
    const tailStart = Math.max(headLength, size - bytes);
    const tailBuffer = Buffer.alloc(size - tailStart);
    await handle.read(tailBuffer, 0, tailBuffer.length, tailStart);
    const firstBreak = tailBuffer.indexOf(NEWLINE);
    const tail = firstBreak < 0 ? [] : completeLines(tailBuffer.subarray(firstBreak + 1), true);
    return { head, tail };
  } finally {
    await handle.close();
  }
}

function completeLines(buffer: Buffer, wholeFile: boolean): string[] {
  const lastBreak = buffer.lastIndexOf(NEWLINE);
  const usable = wholeFile ? buffer : buffer.subarray(0, lastBreak + 1);
  return usable
    .toString('utf8')
    .split('\n')
    .filter(line => line.length > 0);
}
