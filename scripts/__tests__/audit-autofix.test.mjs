import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { computeOverrideFixes, lockfileVersions, patchedFloor, renderSkippedLines } from '../audit-autofix.mjs';

const ALLOWLIST = new Set(['GHSA-known-1111-1111']);

function advisory(overrides = {}) {
  return {
    module_name: 'some-pkg',
    severity: 'high',
    github_advisory_id: 'GHSA-new-aaaa-aaaa',
    vulnerable_versions: '<1.11.0',
    patched_versions: '>=1.11.0',
    findings: [{ version: '1.10.0' }],
    ...overrides,
  };
}
const report = (...advisories) => ({ advisories: Object.fromEntries(advisories.map((a, i) => [i + 1, a])) });

describe('computeOverrideFixes', () => {
  it('(1) adds a floor override for a single advisory', () => {
    const result = computeOverrideFixes(report(advisory()), ALLOWLIST, { esbuild: '0.28.1' });
    expect(result.changed).toBe(true);
    expect(result.overrides).toEqual({ esbuild: '0.28.1', 'some-pkg@<1.11.0': '^1.11.0' });
    expect(result.fixes[0]).toMatchObject({ ghsa: 'GHSA-new-aaaa-aaaa', from: '(none)' });
  });

  it('(2) replaces an existing lower selector in place instead of duplicating it', () => {
    const current = { a: '1.0.0', 'some-pkg@<1.9.0': '^1.9.0', z: '2.0.0' };
    const result = computeOverrideFixes(report(advisory()), ALLOWLIST, current);
    expect(Object.entries(result.overrides)).toEqual([
      ['a', '1.0.0'],
      ['some-pkg@<1.11.0', '^1.11.0'],
      ['z', '2.0.0'],
    ]);
    expect(current).toEqual({ a: '1.0.0', 'some-pkg@<1.9.0': '^1.9.0', z: '2.0.0' });
  });

  it('(3) ignores allowlisted and medium advisories', () => {
    const result = computeOverrideFixes(
      report(
        advisory({ github_advisory_id: 'GHSA-known-1111-1111' }),
        advisory({ github_advisory_id: 'GHSA-new-bbbb-bbbb', severity: 'moderate' })
      ),
      ALLOWLIST,
      {}
    );
    expect(result).toEqual({ overrides: {}, fixes: [], skipped: [], changed: false });
  });

  it('(4) skips and reports an advisory with no patched release', () => {
    const result = computeOverrideFixes(report(advisory({ patched_versions: '<0.0.0' })), ALLOWLIST, {});
    expect(result.changed).toBe(false);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toMatch(/no usable patched version/);
  });

  it('(5) picks the floor above the installed version from a multi-range patched_versions', () => {
    expect(patchedFloor('>=1.2.3 <2.0.0 || >=2.1.0', ['1.1.0'])).toBe('1.2.3');
    expect(patchedFloor('>=1.2.3 <2.0.0 || >=2.1.0', ['2.0.5'])).toBe('2.1.0');
    expect(patchedFloor('>=1.2.3 <2.0.0 || >=2.1.0', [])).toBe('2.1.0');
    expect(patchedFloor('^1.2.3', ['1.0.0'])).toBeNull();
    const result = computeOverrideFixes(
      report(advisory({ patched_versions: '>=1.2.3 <2.0.0 || >=2.1.0', findings: [{ version: '2.0.5' }] })),
      ALLOWLIST,
      {}
    );
    expect(result.overrides).toEqual({ 'some-pkg@<2.1.0': '^2.1.0' });
  });

  it('leaves a floor that would move an installed copy across a major to a human', () => {
    const cases = [
      // Two installed majors: the floor above the newest would drag 1.2.0 to ^2.1.3.
      { patched_versions: '>=1.2.5 <2.0.0 || >=2.1.3', findings: [{ version: '1.2.0' }, { version: '2.0.5' }] },
      // Patched only on the next major.
      { patched_versions: '>=2.1.3', findings: [{ version: '1.9.0' }] },
      // On 0.x a minor bump is a major bump for a caret range.
      { patched_versions: '>=0.36.0', findings: [{ version: '0.35.4' }] },
    ];
    for (const c of cases) {
      const result = computeOverrideFixes(report(advisory(c)), ALLOWLIST, {});
      expect(result.changed).toBe(false);
      expect(result.overrides).toEqual({});
      expect(result.skipped[0].reason).toMatch(/move across a major/);
    }
  });

  it('leaves a floor that does not cover an installed copy to a human', () => {
    // Backport-only patch: 1.2.5 never touches the vulnerable 2.0.5 copy.
    const backport = advisory({ patched_versions: '>=1.2.5 <2.0.0', findings: [{ version: '2.0.5' }] });
    expect(computeOverrideFixes(report(backport), ALLOWLIST, {}).skipped[0].reason).toMatch(
      /not below the patched floor/
    );
    const prerelease = advisory({ findings: [{ version: '1.11.0-rc.1' }] });
    expect(computeOverrideFixes(report(prerelease), ALLOWLIST, {}).skipped[0].reason).toMatch(/not a plain version/);
  });

  it('checks the installed copies of every advisory against the highest floor', () => {
    const result = computeOverrideFixes(
      report(
        advisory({ patched_versions: '>=1.11.0', findings: [{ version: '1.10.0' }] }),
        advisory({
          github_advisory_id: 'GHSA-new-cccc-cccc',
          patched_versions: '>=2.0.1',
          findings: [{ version: '2.0.0' }],
        })
      ),
      ALLOWLIST,
      {}
    );
    expect(result.changed).toBe(false);
    expect(result.skipped.map(s => s.ghsa)).toEqual(['GHSA-new-aaaa-aaaa', 'GHSA-new-cccc-cccc']);
  });

  it('checks unaffected locked copies too, since the override rewrites them as well', () => {
    // Advisory scoped to 2.x: only 2.2.0 is a finding, but `some-pkg@<2.3.1` would also rewrite the 1.x dependent.
    const scoped = advisory({
      vulnerable_versions: '>=2.0.0 <2.3.1',
      patched_versions: '>=2.3.1',
      findings: [{ version: '2.2.0' }],
    });
    const withOlder = new Map([['some-pkg', ['1.9.0', '2.2.0']]]);
    const result = computeOverrideFixes(report(scoped), ALLOWLIST, {}, withOlder);
    expect(result.changed).toBe(false);
    expect(result.skipped[0].reason).toMatch(/`1\.9\.0` would move across a major/);
    // A copy above the floor is not matched by `<2.3.1`, so it does not block the fix.
    const withNewer = new Map([['some-pkg', ['2.2.0', '3.1.0']]]);
    expect(computeOverrideFixes(report(scoped), ALLOWLIST, {}, withNewer).overrides).toEqual({
      'some-pkg@<2.3.1': '^2.3.1',
    });
  });

  it('leaves a package whose existing floor is on another major to a human', () => {
    const scoped = advisory({ patched_versions: '>=2.3.1', findings: [{ version: '2.2.0' }] });
    const current = { 'some-pkg@<1.5.0': '^1.5.0' };
    const result = computeOverrideFixes(report(scoped), ALLOWLIST, current);
    expect(result.overrides).toEqual(current);
    expect(result.skipped[0].reason).toMatch(/floor on another major/);
  });

  it('fails closed when no installed version is known', () => {
    const result = computeOverrideFixes(report(advisory({ findings: [] })), ALLOWLIST, {});
    expect(result.changed).toBe(false);
    expect(result.skipped[0].reason).toMatch(/no installed version found/);
  });

  it('reads every locked version from the packages section only', () => {
    const lock = [
      "lockfileVersion: '9.0'",
      'importers:',
      '  .:',
      '    dependencies:',
      'packages:',
      "  '@scope/x@1.0.0':",
      '    resolution: {integrity: sha512-a}',
      '  some-pkg@1.9.0:',
      '    resolution: {integrity: sha512-b}',
      '  some-pkg@2.2.0:',
      'snapshots:',
      "  '@scope/x@1.0.0(react@18.0.0)':",
      '  some-pkg@9.9.9: {}',
    ].join('\n');
    expect(Object.fromEntries(lockfileVersions(lock))).toEqual({
      '@scope/x': ['1.0.0'],
      'some-pkg': ['1.9.0', '2.2.0'],
    });
  });

  it('renders one parseable line per skipped advisory', () => {
    const result = computeOverrideFixes(report(advisory({ patched_versions: '<0.0.0' })), ALLOWLIST, {});
    expect(renderSkippedLines(result.skipped)).toEqual([
      'GHSA-new-aaaa-aaaa | some-pkg | high | no usable patched version (`<0.0.0`): allowlist or replace',
    ]);
  });

  it('(6) reports no change when nothing fails', () => {
    const current = { 'some-pkg@<1.11.0': '^1.11.0' };
    const result = computeOverrideFixes(report(), ALLOWLIST, current);
    expect(result.changed).toBe(false);
    expect(result.overrides).toEqual(current);
  });

  it('leaves a package pinned by a plain override to a human', () => {
    const result = computeOverrideFixes(report(advisory()), ALLOWLIST, { 'some-pkg': '1.10.0' });
    expect(result.changed).toBe(false);
    expect(result.skipped[0].reason).toMatch(/plain override/);
  });

  it('leaves a package with per-major range or line overrides to a human', () => {
    const current = {
      'some-pkg@<4.0.0': '^3.15.1',
      'some-pkg@>=4.0.0 <5.0.0': '^4.3.1',
      'other@>=7.5.0 <7.6.5': '^7.6.5',
    };
    for (const pkg of ['some-pkg', 'other']) {
      const result = computeOverrideFixes(report(advisory({ module_name: pkg })), ALLOWLIST, current);
      expect(result.changed).toBe(false);
      expect(result.overrides).toEqual(current);
      expect(result.skipped[0].reason).toMatch(/not a floor/);
    }
  });

  it('(7) reproduces the hand-written sharp + shell-quote fix', () => {
    const live = report(
      advisory({
        module_name: 'sharp',
        github_advisory_id: 'GHSA-wq5f-xc86-pv6w',
        vulnerable_versions: '<0.35.5',
        patched_versions: '>=0.35.5',
        findings: [{ version: '0.35.4' }],
      }),
      advisory({
        module_name: 'shell-quote',
        severity: 'critical',
        github_advisory_id: 'GHSA-pqg4-j6r4-53mv',
        vulnerable_versions: '>=1.8.4 <1.11.0',
        patched_versions: '>=1.11.0',
        findings: [{ version: '1.9.0' }, { version: '1.10.0' }],
      })
    );
    const current = { 'shell-quote@<1.9.0': '^1.9.0', 'tar@<7.5.8': '^7.5.8', 'sharp@<0.35.0': '^0.35.3' };
    expect(Object.entries(computeOverrideFixes(live, ALLOWLIST, current).overrides)).toEqual([
      ['shell-quote@<1.11.0', '^1.11.0'],
      ['tar@<7.5.8', '^7.5.8'],
      ['sharp@<0.35.5', '^0.35.5'],
    ]);
  });
});

describe('main (CLI)', () => {
  const scriptPath = fileURLToPath(new URL('../audit-autofix.mjs', import.meta.url));
  let dir;

  beforeEach(() => {
    // realpath: the script's main guard compares against its resolved path (macOS /var -> /private/var).
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'audit-autofix-')));
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.copyFileSync(scriptPath, path.join(dir, 'scripts', 'audit-autofix.mjs'));
    fs.copyFileSync(new URL('../audit-gate.mjs', import.meta.url), path.join(dir, 'scripts', 'audit-gate.mjs'));
    fs.writeFileSync(path.join(dir, 'scripts', 'audit-allowlist.json'), '[]');
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\npackages:\n  some-pkg@1.10.0:\n");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const run = reportJson => {
    fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(reportJson));
    const out = path.join(dir, 'out.txt');
    fs.writeFileSync(out, '');
    const res = spawnSync(process.execPath, [path.join(dir, 'scripts', 'audit-autofix.mjs')], {
      env: {
        ...process.env,
        PACKAGES_JSON_REPORT_PATH: path.join(dir, 'report.json'),
        AUTOFIX_SUMMARY_PATH: path.join(dir, 'summary.md'),
        AUTOFIX_SKIPPED_PATH: path.join(dir, 'skipped.txt'),
        GITHUB_OUTPUT: out,
      },
      encoding: 'utf8',
    });
    return {
      status: res.status,
      output: fs.readFileSync(out, 'utf8'),
      summary: fs.readFileSync(path.join(dir, 'summary.md'), 'utf8'),
      skipped: fs.readFileSync(path.join(dir, 'skipped.txt'), 'utf8'),
    };
  };

  it('(6) leaves package.json byte-identical when nothing fails', () => {
    const original = '{\n  "name": "x",\n  "pnpm": {\n    "overrides": {\n      "a@<1.0.0": "^1.0.0"\n    }\n  }\n}\n';
    fs.writeFileSync(path.join(dir, 'package.json'), original);
    const res = run(report());
    expect(res.status).toBe(0);
    expect(res.output).toBe('changed=false\n');
    // Written even when empty: an empty file means "nothing skipped", a missing one "unknown".
    expect(res.skipped).toBe('');
    expect(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).toBe(original);
  });

  it('writes the override, the summary and changed=true', () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{\n  "name": "x"\n}\n');
    const res = run(report(advisory()));
    expect(res.status).toBe(0);
    expect(res.output).toBe('changed=true\n');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).pnpm.overrides).toEqual({
      'some-pkg@<1.11.0': '^1.11.0',
    });
    expect(res.summary).toMatch(/GHSA-new-aaaa-aaaa/);
    expect(res.summary).toMatch(/CONTRIBUTING\.md#fixing-a-dependency-advisory/);
  });

  it('writes the skipped advisories file', () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{\n  "name": "x"\n}\n');
    const res = run(report(advisory({ patched_versions: '<0.0.0' })));
    expect(res.status).toBe(0);
    expect(res.skipped).toMatch(/^GHSA-new-aaaa-aaaa \| some-pkg \| high \| no usable patched version/);
  });
});
