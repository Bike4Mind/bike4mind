import { describe, it, expect } from 'vitest';
import { extractNewAdvisories, BLOCKED_SEVERITIES } from '../audit-gate.mjs';

const ALLOWLIST = new Set(['GHSA-known-1111-1111', 'GHSA-known-2222-2222']);

function makeAdvisory(overrides = {}) {
  return {
    module_name: 'some-pkg',
    severity: 'high',
    github_advisory_id: 'GHSA-new-aaaa-aaaa',
    ...overrides,
  };
}

describe('extractNewAdvisories -- advisories shape', () => {
  it('returns empty array when all GHSAs are in the allowlist', () => {
    const data = {
      advisories: {
        1: makeAdvisory({ github_advisory_id: 'GHSA-known-1111-1111' }),
        2: makeAdvisory({ github_advisory_id: 'GHSA-known-2222-2222', severity: 'critical' }),
      },
    };
    expect(extractNewAdvisories(data, ALLOWLIST)).toEqual([]);
  });

  it('catches a new high-severity GHSA not in the allowlist', () => {
    const data = {
      advisories: { 1: makeAdvisory({ github_advisory_id: 'GHSA-new-aaaa-aaaa', severity: 'high' }) },
    };
    const result = extractNewAdvisories(data, ALLOWLIST);
    expect(result).toHaveLength(1);
    expect(result[0].ghsa).toBe('GHSA-new-aaaa-aaaa');
    expect(result[0].severity).toBe('high');
  });

  it('catches a new critical-severity GHSA not in the allowlist', () => {
    const data = {
      advisories: { 1: makeAdvisory({ github_advisory_id: 'GHSA-new-bbbb-bbbb', severity: 'critical' }) },
    };
    const result = extractNewAdvisories(data, ALLOWLIST);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('critical');
  });

  it('ignores moderate and low advisories', () => {
    const data = {
      advisories: {
        1: makeAdvisory({ github_advisory_id: 'GHSA-new-cccc-cccc', severity: 'moderate' }),
        2: makeAdvisory({ github_advisory_id: 'GHSA-new-dddd-dddd', severity: 'low' }),
      },
    };
    expect(extractNewAdvisories(data, ALLOWLIST)).toEqual([]);
  });

  it('fails closed when a high/critical advisory has no github_advisory_id', () => {
    const data = {
      advisories: {
        1: { module_name: 'bad-pkg', severity: 'high', id: 123, github_advisory_id: null },
      },
    };
    const result = extractNewAdvisories(data, ALLOWLIST);
    expect(result).toHaveLength(1);
    expect(result[0].ghsa).toMatch(/<no GHSA id>/);
    expect(result[0].pkg).toBe('bad-pkg');
  });
});

describe('extractNewAdvisories -- vulnerabilities shape', () => {
  it('catches a new GHSA in the vulnerabilities shape', () => {
    const data = {
      vulnerabilities: {
        'some-pkg': {
          severity: 'high',
          via: [{ url: 'https://github.com/advisories/GHSA-new-eeee-eeee' }],
        },
      },
    };
    const result = extractNewAdvisories(data, ALLOWLIST);
    expect(result).toHaveLength(1);
    expect(result[0].ghsa).toBe('GHSA-new-eeee-eeee');
  });

  it('deduplicates a GHSA that appears via multiple packages', () => {
    const data = {
      vulnerabilities: {
        'pkg-a': { severity: 'high', via: [{ url: 'https://github.com/advisories/GHSA-new-ffff-ffff' }] },
        'pkg-b': { severity: 'high', via: [{ url: 'https://github.com/advisories/GHSA-new-ffff-ffff' }] },
      },
    };
    const result = extractNewAdvisories(data, ALLOWLIST);
    expect(result).toHaveLength(1);
    expect(result[0].ghsa).toBe('GHSA-new-ffff-ffff');
  });

  it('does not catch an allowlisted GHSA in the vulnerabilities shape', () => {
    const data = {
      vulnerabilities: {
        'some-pkg': {
          severity: 'high',
          via: [{ url: 'https://github.com/advisories/GHSA-known-1111-1111' }],
        },
      },
    };
    expect(extractNewAdvisories(data, ALLOWLIST)).toEqual([]);
  });
});

describe('extractNewAdvisories -- unrecognized shape', () => {
  it('returns null for an empty object', () => {
    expect(extractNewAdvisories({}, ALLOWLIST)).toBeNull();
  });

  it('returns null for an error-shaped report', () => {
    expect(extractNewAdvisories({ error: { code: 'ERR_PNPM_AUDIT_BAD_RESPONSE' } }, ALLOWLIST)).toBeNull();
  });

  it('returns null for a non-object report', () => {
    expect(extractNewAdvisories(null, ALLOWLIST)).toBeNull();
  });
});

describe('BLOCKED_SEVERITIES', () => {
  it('includes high and critical', () => {
    expect(BLOCKED_SEVERITIES.has('high')).toBe(true);
    expect(BLOCKED_SEVERITIES.has('critical')).toBe(true);
  });

  it('does not include moderate or low', () => {
    expect(BLOCKED_SEVERITIES.has('moderate')).toBe(false);
    expect(BLOCKED_SEVERITIES.has('low')).toBe(false);
  });
});
