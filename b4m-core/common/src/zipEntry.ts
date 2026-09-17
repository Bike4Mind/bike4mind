/**
 * Size-bounded read of a single zip entry. An OOXML file (.docx/.xlsx/.pptx) is a zip, and one
 * entry can inflate ~1000x when decompressed - the zip-bomb shape.
 *
 * An entry's DECLARED uncompressed size is not a bound. It is read from the zip's own headers, so
 * the author of the file sets it, and jszip only compares it against reality AFTER the entry has
 * been fully inflated (`lib/compressedObject.js` checks `data_length` on the stream's `end`).
 * An entry that under-declares its size therefore passes a pre-check and still allocates in full.
 * The only guard that holds is bounding the inflate itself, so this reads the entry as a stream
 * and stops on the first chunk that crosses `maxBytes`. jszip's DataWorker feeds the inflater in
 * 16 KB compressed blocks and re-checks `isPaused` before each one, so pausing there caps peak
 * memory at roughly `maxBytes` plus one block's expansion.
 *
 * Lives in @bike4mind/common rather than @bike4mind/utils because both callers (utils' officeEdit
 * and fab-pipeline's PPTX chunker) depend on common, while utils itself depends on fab-pipeline -
 * exporting it from utils would turn that edge into a cycle.
 */

/**
 * The slice of jszip's StreamHelper this reader uses. Declared structurally so common carries no
 * jszip dependency, and because `internalStream` - documented ZipObject API - is absent from the
 * community-maintained `jszip` types, so callers pass their entry through a cast. Must stay in
 * sync with jszip's StreamHelper.
 */
export interface BoundedZipEntryStream {
  on(event: 'data', callback: (chunk: Buffer) => void): BoundedZipEntryStream;
  on(event: 'end', callback: () => void): BoundedZipEntryStream;
  on(event: 'error', callback: (error: Error) => void): BoundedZipEntryStream;
  pause(): BoundedZipEntryStream;
  resume(): BoundedZipEntryStream;
}

export interface BoundedZipEntry {
  internalStream(type: 'nodebuffer'): BoundedZipEntryStream;
}

/**
 * Over-limit is an expected outcome on untrusted input, not an exception, so it comes back as a
 * result the caller has to narrow - one caller rejects the whole upload, the other skips the entry
 * and carries on. `byteLength` is the decompressed size, for callers keeping a running total.
 */
export type BoundedZipEntryResult = { ok: true; text: string; byteLength: number } | { ok: false; reason: 'too-large' };

export function readZipEntryBounded(entry: BoundedZipEntry, maxBytes: number): Promise<BoundedZipEntryResult> {
  return new Promise((resolve, reject) => {
    const stream = entry.internalStream('nodebuffer');
    let parts: Buffer[] = [];
    let byteLength = 0;
    let settled = false;

    stream
      .on('data', chunk => {
        if (settled) return;
        byteLength += chunk.length;
        if (byteLength > maxBytes) {
          settled = true;
          // Halts the pump before the next compressed block reaches the inflater.
          stream.pause();
          parts = [];
          resolve({ ok: false, reason: 'too-large' });
          return;
        }
        parts.push(chunk);
      })
      .on('error', error => {
        if (settled) return;
        settled = true;
        parts = [];
        reject(error);
      })
      .on('end', () => {
        if (settled) return;
        settled = true;
        // Decode once over the joined bytes: a multi-byte character straddling two chunks would
        // be mangled by per-chunk decoding.
        resolve({ ok: true, text: Buffer.concat(parts).toString('utf8'), byteLength });
      })
      .resume();
  });
}
