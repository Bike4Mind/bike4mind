import type JSZip from 'jszip';
import type { BoundedZipEntry } from '@bike4mind/common';

/**
 * Result of measuring a whole zip container against a decompression budget. `failedEntries` are
 * entries whose inflate raised (a damaged payload, a size or CRC mismatch); their bytes up to the
 * error still count toward the budget, since a parser may inflate that much before failing too.
 */
export type ZipBudgetResult = { ok: true; inflatedBytes: number; failedEntries: string[] } | { ok: false };

type EntryMeasurement = { byteLength: number; overBudget: boolean; failed: boolean };

/**
 * Inflates one entry as a stream, counting bytes and discarding them, and stops on the first chunk
 * that crosses `maxBytes`. Same pause-on-overflow mechanism as readZipEntryBounded in
 * @bike4mind/common, without buffering or decoding the payload.
 */
function measureZipEntry(entry: BoundedZipEntry, maxBytes: number): Promise<EntryMeasurement> {
  return new Promise(resolve => {
    const stream = entry.internalStream('nodebuffer');
    let byteLength = 0;
    let settled = false;
    const settle = (overBudget: boolean, failed: boolean) => {
      if (settled) return;
      settled = true;
      resolve({ byteLength, overBudget, failed });
    };

    stream
      .on('data', chunk => {
        if (settled) return;
        byteLength += chunk.length;
        if (byteLength > maxBytes) {
          stream.pause();
          settle(true, false);
        }
      })
      .on('error', () => settle(false, true))
      .on('end', () => settle(false, false))
      .resume();
  });
}

/**
 * Inflates every file entry of `zip` against one shared budget, whatever the entry is named: the
 * parsers this guards read parts by relationship target or by central-directory order, not by
 * extension, so every entry counts. Measured as each entry inflates, never from the sizes the
 * zip's own headers declare.
 */
export async function measureZipContainer(zip: JSZip, maxTotalBytes: number): Promise<ZipBudgetResult> {
  let inflatedBytes = 0;
  const failedEntries: string[] = [];
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    // `internalStream` is documented ZipObject API but is missing from the `jszip` types.
    const measured = await measureZipEntry(entry as unknown as BoundedZipEntry, maxTotalBytes - inflatedBytes);
    if (measured.overBudget) return { ok: false };
    inflatedBytes += measured.byteLength;
    if (measured.failed) failedEntries.push(entry.name);
  }
  return { ok: true, inflatedBytes, failedEntries };
}
