/**
 * Split a top-level JSON array of objects into one parsed element at a time, from a byte
 * stream, so a conversations.json of hundreds of MB is never held as one string.
 *
 * Works on bytes rather than decoded text so a multi-byte character split across two chunks is
 * never decoded in halves. Top-level primitives are skipped; an element over `maxElementBytes`
 * or one that does not parse is reported as `null` so the caller can count it as failed.
 */
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;

export async function* streamJsonArray(
  chunks: AsyncIterable<Buffer>,
  maxElementBytes: number
): AsyncGenerator<unknown | null> {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let pieces: Buffer[] = [];
  let pieceBytes = 0;
  let oversize = false;
  let sawArray = false;

  for await (const chunk of chunks) {
    let elementStart = depth >= 2 ? 0 : -1;
    for (let index = 0; index < chunk.length; index++) {
      const byte = chunk[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (byte === BACKSLASH) escaped = true;
        else if (byte === QUOTE) inString = false;
        continue;
      }
      if (byte === QUOTE) {
        inString = true;
      } else if (byte === OPEN_BRACE || byte === OPEN_BRACKET) {
        depth++;
        if (depth === 1) {
          if (byte !== OPEN_BRACKET) throw new Error('expected a JSON array');
          sawArray = true;
        } else if (depth === 2) {
          elementStart = index;
          pieces = [];
          pieceBytes = 0;
          oversize = false;
        }
      } else if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) {
        depth--;
        if (depth === 1 && elementStart >= 0) {
          const tail = chunk.subarray(elementStart, index + 1);
          pieceBytes += tail.length;
          if (!oversize && pieceBytes <= maxElementBytes) pieces.push(tail);
          else oversize = true;
          yield oversize ? null : parseElement(pieces);
          pieces = [];
          elementStart = -1;
        } else if (depth === 0) {
          return;
        } else if (depth < 0) {
          throw new Error('malformed JSON');
        }
      }
    }
    if (depth >= 2 && elementStart >= 0) {
      const rest = chunk.subarray(elementStart);
      pieceBytes += rest.length;
      // Copied: the stream may reuse the chunk's memory once this generator yields.
      if (!oversize && pieceBytes <= maxElementBytes) pieces.push(Buffer.from(rest));
      else {
        oversize = true;
        pieces = [];
      }
    }
  }
  if (!sawArray) throw new Error('expected a JSON array');
  if (depth !== 0) throw new Error('the export ended part-way through');
}

function parseElement(pieces: Buffer[]): unknown | null {
  try {
    return JSON.parse(Buffer.concat(pieces).toString('utf8'));
  } catch {
    return null;
  }
}
