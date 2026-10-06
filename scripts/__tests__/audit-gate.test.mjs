import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { extractNewAdvisories, classifyAgainstBase, BLOCKED_SEVERITIES } from '../audit-gate.mjs';

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

describe('classifyAgainstBase', () => {
  const report = (...ids) => ({
    advisories: Object.fromEntries(ids.map((id, i) => [i + 1, makeAdvisory({ github_advisory_id: id })])),
  });

  it('reports a GHSA on both base and head as pre-existing, not introduced', () => {
    const result = classifyAgainstBase(report('GHSA-new-aaaa-aaaa'), report('GHSA-new-aaaa-aaaa'), ALLOWLIST);
    expect(result.introduced).toEqual([]);
    expect(result.preExisting.map(a => a.ghsa)).toEqual(['GHSA-new-aaaa-aaaa']);
  });

  it('flags a GHSA only on head as introduced', () => {
    const result = classifyAgainstBase(
      report('GHSA-new-aaaa-aaaa', 'GHSA-new-bbbb-bbbb'),
      report('GHSA-new-aaaa-aaaa'),
      ALLOWLIST
    );
    expect(result.introduced.map(a => a.ghsa)).toEqual(['GHSA-new-bbbb-bbbb']);
    expect(result.preExisting.map(a => a.ghsa)).toEqual(['GHSA-new-aaaa-aaaa']);
  });

  it('ignores a GHSA only on base (fixed by the change)', () => {
    expect(classifyAgainstBase(report(), report('GHSA-new-aaaa-aaaa'), ALLOWLIST)).toEqual({
      introduced: [],
      preExisting: [],
    });
  });

  it('ignores an allowlisted GHSA introduced on head', () => {
    expect(classifyAgainstBase(report('GHSA-known-1111-1111'), report(), ALLOWLIST)).toEqual({
      introduced: [],
      preExisting: [],
    });
  });

  it('returns null when either report has an unrecognized shape', () => {
    expect(classifyAgainstBase(report(), {}, ALLOWLIST)).toBeNull();
    expect(classifyAgainstBase({}, report(), ALLOWLIST)).toBeNull();
    expect(classifyAgainstBase(report(), null, ALLOWLIST)).toBeNull();
  });

  it('classifies the vulnerabilities shape on both sides', () => {
    const vulns = (...ids) => ({
      vulnerabilities: Object.fromEntries(
        ids.map(id => [`pkg-${id}`, { severity: 'high', via: [{ url: `https://github.com/advisories/${id}` }] }])
      ),
    });
    const result = classifyAgainstBase(
      vulns('GHSA-new-aaaa-aaaa', 'GHSA-new-bbbb-bbbb'),
      vulns('GHSA-new-aaaa-aaaa'),
      ALLOWLIST
    );
    expect(result.introduced.map(a => a.ghsa)).toEqual(['GHSA-new-bbbb-bbbb']);
    expect(result.preExisting.map(a => a.ghsa)).toEqual(['GHSA-new-aaaa-aaaa']);
  });
});

describe('main (CLI)', () => {
  const scriptPath = fileURLToPath(new URL('../audit-gate.mjs', import.meta.url));
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-gate-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Fake ids so the real allowlist never matches.
  const report = (...ids) =>
    JSON.stringify({
      advisories: Object.fromEntries(ids.map((id, i) => [i + 1, makeAdvisory({ github_advisory_id: id })])),
    });
  const write = (name, content) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, content);
    return p;
  };
  const run = env => {
    const rest = { ...process.env };
    delete rest.GITHUB_STEP_SUMMARY;
    const res = spawnSync(process.execPath, [scriptPath], { env: { ...rest, ...env }, encoding: 'utf8' });
    return { status: res.status, output: res.stdout + res.stderr };
  };

  it('fails closed when the base report is missing', () => {
    const head = write('head.json', report());
    const res = run({ PACKAGES_JSON_REPORT_PATH: head, BASE_JSON_REPORT_PATH: path.join(dir, 'missing.json') });
    expect(res.status).toBe(1);
    expect(res.output).toMatch(/base audit report/);
  });

  it('fails closed when the base report is invalid JSON', () => {
    const head = write('head.json', report());
    const base = write('base.json', '{not json');
    expect(run({ PACKAGES_JSON_REPORT_PATH: head, BASE_JSON_REPORT_PATH: base }).status).toBe(1);
  });

  it('fails closed when the base report has an unrecognized shape', () => {
    const head = write('head.json', report());
    const base = write('base.json', '{"error":{"code":"ERR_PNPM_AUDIT_BAD_RESPONSE"}}');
    expect(run({ PACKAGES_JSON_REPORT_PATH: head, BASE_JSON_REPORT_PATH: base }).status).toBe(1);
  });

  it('passes with a warning when the advisory is already on base', () => {
    const head = write('head.json', report('GHSA-test-aaaa-aaaa'));
    const base = write('base.json', report('GHSA-test-aaaa-aaaa'));
    const res = run({ PACKAGES_JSON_REPORT_PATH: head, BASE_JSON_REPORT_PATH: base });
    expect(res.status).toBe(0);
    expect(res.output).toMatch(/::warning::.*GHSA-test-aaaa-aaaa/);
  });

  it('writes pre-existing advisories to the step summary', () => {
    const head = write('head.json', report('GHSA-test-aaaa-aaaa'));
    const base = write('base.json', report('GHSA-test-aaaa-aaaa'));
    const summary = write('summary.md', '');
    expect(
      run({ PACKAGES_JSON_REPORT_PATH: head, BASE_JSON_REPORT_PATH: base, GITHUB_STEP_SUMMARY: summary }).status
    ).toBe(0);
    expect(fs.readFileSync(summary, 'utf8')).toMatch(/Already on main[\s\S]*GHSA-test-aaaa-aaaa/);
  });

  it('fails on an advisory only on head and points at the playbook', () => {
    const head = write('head.json', report('GHSA-test-bbbb-bbbb'));
    const base = write('base.json', report());
    const res = run({ PACKAGES_JSON_REPORT_PATH: head, BASE_JSON_REPORT_PATH: base });
    expect(res.status).toBe(1);
    expect(res.output).toMatch(/introduced by this PR/);
    expect(res.output).toMatch(/CONTRIBUTING\.md#fixing-a-dependency-advisory/);
  });

  it('keeps full-mode behavior when no base report is set', () => {
    expect(run({ PACKAGES_JSON_REPORT_PATH: write('bad.json', report('GHSA-test-cccc-cccc')) }).status).toBe(1);
    expect(run({ PACKAGES_JSON_REPORT_PATH: write('clean.json', report()) }).status).toBe(0);
  });
});
