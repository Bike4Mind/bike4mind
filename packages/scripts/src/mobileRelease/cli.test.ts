import { describe, expect, it } from 'vitest';
import { USAGE, runCli } from './cli';

const MATRIX = {
  features: [
    { id: 'chat', title: 'Chat', train: '26.12', web: 'green', ios: 'green', android: 'green' },
    { id: 'widgets', title: 'Widgets', train: '27.1', web: 'na', ios: 'green', android: 'red' },
  ],
};

function run(argv: string[], files: Record<string, string> = { 'matrix.json': JSON.stringify(MATRIX) }) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = runCli(
    argv,
    {
      stdout: line => stdout.push(line),
      stderr: line => stderr.push(line),
      readFile: path => {
        if (!(path in files)) throw new Error(`ENOENT: ${path}`);
        return files[path];
      },
      now: () => new Date('2026-11-17T09:00:00Z'),
    },
    'matrix.json'
  );
  return { code, stdout, stderr };
}

describe('usage', () => {
  it('prints usage for a missing or unknown command', () => {
    expect(run([])).toEqual({ code: 2, stdout: [], stderr: [USAGE] });
    expect(run(['ship'])).toEqual({ code: 2, stdout: [], stderr: [USAGE] });
  });

  it('rejects unknown options and positionals', () => {
    const result = run(['validate', '--force']);
    expect(result.code).toBe(2);
    expect(result.stderr[0]).toMatch(/--force/);
    expect(result.stderr[1]).toBe(USAGE);
    expect(run(['validate', 'extra']).code).toBe(2);
  });
});

describe('validate', () => {
  it('passes on a valid matrix, from the default or a given path', () => {
    expect(run(['validate'])).toEqual({ code: 0, stdout: ['Parity matrix OK: 2 features.'], stderr: [] });
    expect(run(['validate', '--matrix', 'other.json'], { 'other.json': '{"features":[]}' }).stdout).toEqual([
      'Parity matrix OK: 0 features.',
    ]);
  });

  it('fails on an unreadable file or invalid JSON', () => {
    expect(run(['validate'], {})).toEqual({
      code: 1,
      stdout: [],
      stderr: ['Cannot read the parity matrix at matrix.json: ENOENT: matrix.json'],
    });
    const invalidJson = run(['validate'], { 'matrix.json': '{' });
    expect(invalidJson.code).toBe(1);
    expect(invalidJson.stderr[0]).toMatch(/^Cannot read the parity matrix at matrix\.json: /);
  });

  it('lists every schema problem', () => {
    const result = run(['validate'], { 'matrix.json': '{"features":[{"id":"a"},{"id":"b"}]}' });
    expect(result.code).toBe(1);
    expect(result.stderr[0]).toBe('Invalid parity matrix at matrix.json:');
    expect(result.stderr.slice(1).every(line => line.startsWith('  features.'))).toBe(true);
  });
});

describe('plan', () => {
  it('prints the build outputs from a tag', () => {
    expect(run(['plan', '--platform', 'android', '--tag', 'mobile-v26.12.0-rc.2'])).toEqual({
      code: 0,
      stdout: ['version=26.12.0', 'build_number=26120002', 'tag=mobile-v26.12.0-rc.2', 'client_name=b4m-android'],
      stderr: ['Parity gate: every feature due by train 26.12 is green on android.'],
    });
  });

  it('prints the build outputs from a version and rc, empty rc meaning final', () => {
    expect(run(['plan', '--platform', 'ios', '--version', '26.12.1', '--rc', '']).stdout).toEqual([
      'version=26.12.1',
      'build_number=26120199',
      'tag=mobile-v26.12.1',
      'client_name=b4m-ios',
    ]);
    expect(run(['plan', '--platform', 'ios', '--version', '26.12.1', '--rc', '3']).stdout[1]).toBe(
      'build_number=26120103'
    );
  });

  it('blocks a train with a feature due that is not green on the platform', () => {
    expect(run(['plan', '--platform', 'android', '--tag', 'mobile-v27.1.0'])).toEqual({
      code: 1,
      stdout: [],
      stderr: [
        'Parity gate: 1 feature(s) due by train 27.1 are not green on android:',
        '  widgets (train 27.1, android: red)',
        'Ship them, or retarget them to a later train in the parity matrix.',
      ],
    });
    expect(run(['plan', '--platform', 'ios', '--tag', 'mobile-v27.1.0']).code).toBe(0);
  });

  it('needs a mobile platform', () => {
    const expected = { code: 2, stdout: [], stderr: ['plan needs --platform ios or android.'] };
    expect(run(['plan', '--tag', 'mobile-v26.12.0'])).toEqual(expected);
    expect(run(['plan', '--platform', 'web', '--tag', 'mobile-v26.12.0'])).toEqual(expected);
  });

  it('needs exactly one of --tag and --version, each well-formed', () => {
    expect(run(['plan', '--platform', 'ios']).stderr).toEqual(['plan needs --tag or --version.']);
    expect(run(['plan', '--platform', 'ios', '--tag', 'mobile-v26.12.0', '--version', '26.12.0']).stderr).toEqual([
      'Pass --tag or --version, not both.',
    ]);
    expect(run(['plan', '--platform', 'ios', '--tag', 'v26.12.0'])).toEqual({
      code: 2,
      stdout: [],
      stderr: ['Not a release tag: "v26.12.0" (expected mobile-vYY.M.PATCH or mobile-vYY.M.PATCH-rc.N)'],
    });
    expect(run(['plan', '--platform', 'ios', '--version', '26.12.0', '--rc', '0']).stderr).toEqual([
      'Not a train version and rc: "26.12.0", rc "0" (rc is 1-98 or empty)',
    ]);
    expect(run(['plan', '--platform', 'ios', '--version', '0.1.0']).stderr).toEqual([
      'Not a train version and rc: "0.1.0", rc "" (rc is 1-98 or empty)',
    ]);
  });

  it('fails when the matrix cannot be loaded', () => {
    const result = run(['plan', '--platform', 'ios', '--tag', 'mobile-v26.12.0', '--matrix', 'missing.json']);
    expect(result.code).toBe(1);
    expect(result.stdout).toEqual([]);
  });
});

describe('train-version', () => {
  it('defaults to today in UTC', () => {
    expect(run(['train-version'])).toEqual({ code: 0, stdout: ['26.11.0'], stderr: [] });
  });

  it('takes a cut date', () => {
    expect(run(['train-version', '--date', '2027-01-04']).stdout).toEqual(['27.1.0']);
  });

  it.each(['2027-1-4', '2027-13-01', '2027-02-30', 'tomorrow'])('rejects %s', date => {
    expect(run(['train-version', '--date', date])).toEqual({
      code: 2,
      stdout: [],
      stderr: [`Not a date: "${date}" (expected YYYY-MM-DD)`],
    });
  });
});

describe('check-minimums', () => {
  it('lists each mobile minimum', () => {
    expect(run(['check-minimums', '--minimums', '{"b4m-ios":"26.12.0","b4m-sdk-ts":"2.1.0"}'])).toEqual({
      code: 0,
      stdout: ['b4m-ios: 26.12.0', 'b4m-android: not gated'],
      stderr: [],
    });
  });

  it('fails on a mobile minimum that is not a train version', () => {
    const result = run(['check-minimums', '--minimums', '{"b4m-android":"26.12.0-rc.1"}']);
    expect(result.code).toBe(1);
    expect(result.stderr).toEqual(['b4m-android: "26.12.0-rc.1" is not a train version (YY.M.PATCH, e.g. 26.11.0)']);
    expect(result.stdout).toEqual(['b4m-ios: not gated', 'b4m-android: 26.12.0-rc.1']);
  });

  it('fails on a value the setting itself would reject', () => {
    const result = run(['check-minimums', '--minimums', '{"B4M-IOS":"x"}']);
    expect(result.code).toBe(1);
    expect(result.stderr[0]).toBe('--minimums is not a valid minimumClientVersions value:');
    expect(result.stderr.length).toBeGreaterThan(1);
    const root = run(['check-minimums', '--minimums', '"x"']);
    expect(root.stderr[1]).toMatch(/^ {2}\(root\): /);
  });

  it('fails on invalid JSON and needs the option', () => {
    const invalid = run(['check-minimums', '--minimums', '{']);
    expect(invalid.code).toBe(1);
    expect(invalid.stderr[0]).toMatch(/^--minimums is not JSON: /);
    expect(run(['check-minimums'])).toEqual({
      code: 2,
      stdout: [],
      stderr: ['check-minimums needs --minimums <json>.'],
    });
  });
});
