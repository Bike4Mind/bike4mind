import { createHash } from 'crypto';
import type { FabFileChunkPolicyConflict, FabFileSourceType } from '@bike4mind/common';

/**
 * The lake admission contract (#1679).
 *
 * A data lake is written to through a growing set of doors - the batch/wizard upload, the direct
 * file API, the S3 event pipeline, the chat-platform add command, and the cloud-storage folder
 * connector (#1586). Left to themselves each door re-derives its own chunking, its own idea of
 * "done", and its own (or no) provenance, which is why four chunk sizes are in play and the lake
 * cannot say which door a member came through.
 *
 * This module is the shared idea of "done" those doors converge on. It does NOT try to make every
 * door call one create function - they upload bytes in genuinely different ways - it defines the
 * guarantees a member must satisfy once admitted, evaluated at the ONE checkpoint every door's file
 * already flows through: the chunk pipeline (even the S3 door merely re-enqueues chunking). At that
 * checkpoint the contract:
 *
 *   1. computes a server-verified text hash over the extracted text (`computeServerTextHash`), the
 *      trustworthy dedup input the acquisition proposal queue (#1671) needs - unlike the client
 *      byte-hash `contentHash`, which only two doors write and none verify server-side; and
 *   2. decides the member's retrievability against the applicable chunk policy
 *      (`deriveAdmissionStatus`): a member whose chunks cannot honor a lake it belongs to is
 *      `quarantined` rather than silently admitted as content that will never be retrievable.
 *
 * REPORT-ONLY. Per the epic's report-only-before-enforcing rule (#1658), this contract RECORDS the
 * admission decision and computes the hash; it does not yet block a quarantined member. Turning the
 * decision into a hard gate is #1680, which reads the same `chunkPolicyConflict` signal this derives
 * `quarantined` from - so there is a single source of truth for "cannot be honored", not two.
 *
 * Provenance ("which door") is carried by the existing `FabFile.sourceType`, stamped by each door at
 * create time; `admissionDoorLabel` renders it for the checkpoint's diagnostic.
 */

/** Whether an admitted member's chunks honor every lake policy that applies to it. */
export type AdmissionStatus = 'admitted' | 'quarantined';

/**
 * Collapse insignificant text differences so the hash is a "materially changed" signal (#1671),
 * not a byte-identity check: normalize to NFC, fold every run of Unicode whitespace to a single
 * space, and trim. Two extractions of the same document that differ only in line wrapping or
 * trailing whitespace hash equal; a real content change does not.
 */
export function normalizeTextForHash(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/**
 * Server-verified SHA-256 (hex) over a file's extracted text. Fed the per-chunk texts the pipeline
 * produced - the exact content that became retrievable - joined in chunk order so the hash is
 * deterministic for a given extraction. Returns undefined when there is no extractable text (a file
 * that chunked to nothing), so a caller never records an empty-string hash that would collide across
 * every text-less file. This is computed on the server from bytes we hold, which is what makes it
 * trustworthy where `contentHash` (client-supplied, unverified) is not.
 */
export function computeServerTextHash(chunkTexts: readonly string[]): string | undefined {
  const normalized = normalizeTextForHash(chunkTexts.join('\n'));
  if (!normalized) return undefined;
  return createHash('sha256').update(normalized).digest('hex');
}

/**
 * The admission decision, derived from the cross-lake chunk-policy conflict the checkpoint already
 * computes (#1662): a member with an unresolved conflict cannot honor a lake it belongs to, so it is
 * `quarantined`; otherwise it is `admitted`. Derived rather than stored as a second field so the
 * "cannot be honored" truth lives in exactly one place (`chunkPolicyConflict`), which #1680 enforces.
 */
export function deriveAdmissionStatus(conflict: FabFileChunkPolicyConflict | null): AdmissionStatus {
  return conflict ? 'quarantined' : 'admitted';
}

/** Human-/log-readable door label for a member's provenance; `unknown` when a door left it unset. */
export function admissionDoorLabel(sourceType: FabFileSourceType | undefined): string {
  return sourceType ?? 'unknown';
}
