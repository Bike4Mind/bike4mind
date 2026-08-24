import { createHash } from 'crypto';
import type { FabFileChunkPolicyConflict, FabFileSourceType } from '@bike4mind/common';

/**
 * The lake admission contract (#1679): the shared idea of "done" every ingestion door converges on,
 * evaluated at the ONE checkpoint every door's file already flows through - the chunk pipeline. It
 * does not funnel the structurally-different doors through one create call; it (1) fingerprints the
 * extracted text (`computeServerTextHash`) and (2) derives the member's retrievability against the
 * applicable chunk policy (`deriveAdmissionStatus`). Provenance is carried by `FabFile.sourceType`.
 *
 * This module stays REPORT-ONLY, and deliberately so: it runs POST-chunk, by which point the file is
 * already a member, and the contract governs admission rather than eviction. The hard gate reads the
 * same `chunkPolicyConflict` comparison at the MEMBERSHIP WRITE instead - see `lakeAdmissionGate.ts`
 * (#1680), which refuses a new membership before the content is ever ingested.
 */

/** Whether an admitted member's chunks honor every lake policy that applies to it. */
export type AdmissionStatus = 'admitted' | 'quarantined';

/**
 * Collapse insignificant text differences so the hash is a "materially changed" signal, not a
 * byte-identity check: NFC, fold Unicode whitespace runs to one space, trim. Same document differing
 * only in wrapping/trailing whitespace hashes equal; a real content change does not.
 */
export function normalizeTextForHash(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/**
 * Server-verified SHA-256 (hex) over a file's CANONICAL EXTRACTED TEXT - the text as extracted from
 * the document (SmartChunker.getExtractedText), NOT the chunker's output. That distinction is load-
 * bearing: chunk boundaries, structural JSON/CSV/XLSX envelopes, and data-URL redaction all move with
 * chunkTokenLimit/model, so hashing chunk output would make two byte-identical files under different
 * chunk policies fingerprint differently - the exact false "materially changed" signal this field
 * exists to be immune to. Trustworthy for #1671 dedup where the client byte-hash `contentHash` is not
 * (unverified, absent on connector files). Undefined when there is no extractable text, so a caller
 * never records an empty-string hash that collides across every text-less file.
 */
export function computeServerTextHash(extractedText: string | undefined): string | undefined {
  if (!extractedText) return undefined;
  const normalized = normalizeTextForHash(extractedText);
  if (!normalized) return undefined;
  return createHash('sha256').update(normalized).digest('hex');
}

/**
 * The admission decision, derived from the cross-lake chunk-policy conflict the checkpoint already
 * computes (#1662): a member with an unresolved conflict cannot honor a lake it belongs to, so it is
 * `quarantined`; otherwise it is `admitted`. Derived rather than stored as a second field so the
 * "cannot be honored" truth lives in exactly one place (`chunkPolicyConflict`) - the same place
 * `lakeAdmissionGate` enforces from, so the report and the gate cannot disagree.
 */
export function deriveAdmissionStatus(conflict: FabFileChunkPolicyConflict | null): AdmissionStatus {
  return conflict ? 'quarantined' : 'admitted';
}

/** Human-/log-readable door label for a member's provenance; `unknown` when a door left it unset. */
export function admissionDoorLabel(sourceType: FabFileSourceType | undefined): string {
  return sourceType ?? 'unknown';
}
