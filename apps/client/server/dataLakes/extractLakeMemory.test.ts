import { describe, expect, it } from 'vitest';
import { evidenceTierForDoc } from './extractLakeMemory';

describe('evidenceTierForDoc', () => {
  it('defaults to external-facing when no curator tag is present', () => {
    expect(evidenceTierForDoc([])).toBe('external-facing');
    expect(evidenceTierForDoc(['acme:type:spec', 'datalake:acme'])).toBe('external-facing');
  });

  it('promotes to human-reviewed on a bare reserved marker', () => {
    expect(evidenceTierForDoc(['reviewed'])).toBe('human-reviewed');
    expect(evidenceTierForDoc(['Authoritative'])).toBe('human-reviewed'); // case-insensitive
  });

  it('promotes on a namespaced curator marker (ends with :marker)', () => {
    expect(evidenceTierForDoc(['acme:status:reviewed'])).toBe('human-reviewed');
    expect(evidenceTierForDoc(['acme:type:spec', 'curation:authoritative'])).toBe('human-reviewed');
  });

  it('does not match a marker that is only a substring (e.g. "reviewedby")', () => {
    expect(evidenceTierForDoc(['reviewedby-jane', 'authoritativeness'])).toBe('external-facing');
  });
});
