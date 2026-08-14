import { describe, expect, it } from 'vitest';
import type { FabFileChunkPolicyConflict } from '@bike4mind/common';
import { FabFileSourceType } from '@bike4mind/common';
import {
  admissionDoorLabel,
  computeServerTextHash,
  deriveAdmissionStatus,
  normalizeTextForHash,
} from './admissionContract';

describe('normalizeTextForHash', () => {
  it('collapses every run of whitespace to a single space and trims', () => {
    expect(normalizeTextForHash('  a\t\tb\n\n c  ')).toBe('a b c');
  });

  it('normalizes to NFC so canonically-equivalent forms compare equal', () => {
    const composed = 'caf\u00e9'; // precomposed 'e-acute' (already NFC)
    const decomposed = 'cafe\u0301'; // 'e' + combining acute (NFD form)
    expect(decomposed).not.toBe(composed);
    expect(normalizeTextForHash(decomposed)).toBe(normalizeTextForHash(composed));
  });

  it('reduces text that is only whitespace to the empty string', () => {
    expect(normalizeTextForHash('  \n\t  ')).toBe('');
  });
});

describe('computeServerTextHash', () => {
  it('is deterministic for the same extracted text', () => {
    const a = computeServerTextHash('hello world');
    const b = computeServerTextHash('hello world');
    expect(a).toBeDefined();
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ignores insignificant whitespace differences (a "materially changed" signal, not byte identity)', () => {
    // Same words, different line wrapping / spacing - e.g. two extractions of the same document.
    const wrapped = computeServerTextHash('the quick brown fox jumps');
    const reflowed = computeServerTextHash('the   quick\nbrown   fox\n\njumps  ');
    expect(wrapped).toBe(reflowed);
  });

  it('changes when the text materially changes', () => {
    expect(computeServerTextHash('the quick brown fox')).not.toBe(computeServerTextHash('the quick red fox'));
  });

  it('returns undefined for text-less input rather than hashing the empty string', () => {
    // A hashed empty string would collide across every extraction that yields no text.
    expect(computeServerTextHash(undefined)).toBeUndefined();
    expect(computeServerTextHash('')).toBeUndefined();
    expect(computeServerTextHash('  \n\t ')).toBeUndefined();
  });
});

describe('deriveAdmissionStatus', () => {
  const conflict: FabFileChunkPolicyConflict = {
    effectiveTarget: 512,
    embeddingModel: 'text-embedding-3-small',
    lakes: [],
    detectedAt: new Date(),
  };

  it('is admitted when there is no unresolved chunk-policy conflict', () => {
    expect(deriveAdmissionStatus(null)).toBe('admitted');
  });

  it('is quarantined when the member cannot honor an applicable lake policy', () => {
    expect(deriveAdmissionStatus(conflict)).toBe('quarantined');
  });
});

describe('admissionDoorLabel', () => {
  it('renders the stamped source type', () => {
    expect(admissionDoorLabel(FabFileSourceType.GOOGLE_DRIVE)).toBe('google_drive');
    expect(admissionDoorLabel(FabFileSourceType.MANUAL_UPLOAD)).toBe('manual_upload');
  });

  it('falls back to unknown when a door left provenance unset', () => {
    expect(admissionDoorLabel(undefined)).toBe('unknown');
  });
});
