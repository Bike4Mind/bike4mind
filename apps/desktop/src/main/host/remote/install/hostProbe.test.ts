import { describe, expect, it } from 'vitest';
import { HOST_EXIT_CODES } from '../../../../host/headless/exitCodes';
import { installBlocker, parseHostProbe, type HostProbe } from './hostProbe';

const answer = (...lines: string[]) => ['b4m-probe format 1', ...lines, 'b4m-probe end 1'];
const BASE = ['b4m-probe os Linux', 'b4m-probe arch x86_64', 'b4m-probe tar yes'];

const probe = (overrides: Partial<HostProbe> = {}): HostProbe => ({
  os: 'Linux',
  arch: 'aarch64',
  hasTar: true,
  node: { path: '/usr/bin/node', version: 'v24.1.0', major: 24 },
  installedVersions: [],
  launcher: { state: 'absent' },
  daemon: { state: 'none' },
  ...overrides,
});

describe('parseHostProbe', () => {
  it('reads a full answer and ignores what a login shell printed around it', () => {
    const parsed = parseHostProbe([
      'Welcome to the machine',
      ...answer(
        ...BASE,
        'b4m-probe node /home/me/.nvm/versions/node/v24.3.0/bin/node',
        'b4m-probe nodeVersion v24.3.0',
        'b4m-probe installed 1.2.0',
        'b4m-probe installed 1.3.0',
        'b4m-probe installed 1.3.0.tmp',
        'b4m-probe launcherExit 0',
        'b4m-probe active 1.3.0',
        'b4m-probe daemon 1.2.0'
      ),
    ]);
    expect(parsed).toEqual({
      os: 'Linux',
      arch: 'x86_64',
      hasTar: true,
      node: { path: '/home/me/.nvm/versions/node/v24.3.0/bin/node', version: 'v24.3.0', major: 24 },
      installedVersions: ['1.2.0', '1.3.0'],
      launcher: { state: 'works', version: '1.3.0' },
      daemon: { state: 'running', version: '1.2.0' },
    });
  });

  it('reads a bare machine', () => {
    expect(parseHostProbe(answer(...BASE))).toMatchObject({
      node: null,
      installedVersions: [],
      launcher: { state: 'absent' },
      daemon: { state: 'none' },
    });
  });

  it('reads a failing launcher, an unreadable node version and a daemon it could not check', () => {
    expect(
      parseHostProbe(
        answer(
          ...BASE,
          'b4m-probe node /opt/node',
          'b4m-probe nodeVersion ',
          `b4m-probe launcherExit ${HOST_EXIT_CODES.nodeMissing}`,
          'b4m-probe active ',
          'b4m-probe daemon unknown'
        )
      )
    ).toMatchObject({
      node: { path: '/opt/node', version: '', major: null },
      launcher: { state: 'fails', exitCode: HOST_EXIT_CODES.nodeMissing },
      daemon: { state: 'unknown' },
    });
  });

  it('counts a launcher that exits 0 without a version as failing', () => {
    expect(parseHostProbe(answer(...BASE, 'b4m-probe launcherExit 0', 'b4m-probe active hello'))?.launcher).toEqual({
      state: 'fails',
      exitCode: HOST_EXIT_CODES.failure,
    });
  });

  it.each([
    ['no end line', ['b4m-probe format 1', ...BASE]],
    ['an unknown format', ['b4m-probe format 2', ...BASE, 'b4m-probe end 1']],
    ['a missing key', answer('b4m-probe os Linux', 'b4m-probe tar yes')],
    ['a repeated key', answer(...BASE, 'b4m-probe os Darwin')],
    ['a bad tar answer', answer('b4m-probe os Linux', 'b4m-probe arch x86_64', 'b4m-probe tar maybe')],
    ['a non-numeric exit code', answer(...BASE, 'b4m-probe launcherExit x')],
    ['nothing at all', []],
  ])('returns null for %s', (_name, lines) => {
    expect(parseHostProbe(lines)).toBeNull();
  });
});

describe('installBlocker', () => {
  it('accepts a supported machine with a new enough Node.js', () => {
    expect(installBlocker(probe(), 'box')).toBeNull();
    expect(installBlocker(probe({ os: 'Darwin', arch: 'arm64' }), 'box')).toBeNull();
  });

  it.each([
    ['another system', probe({ os: 'FreeBSD' }), 'unsupportedPlatform'],
    ['another machine', probe({ arch: 'riscv64' }), 'unsupportedPlatform'],
    ['no tar', probe({ hasTar: false }), 'unsupportedPlatform'],
    ['no Node.js', probe({ node: null }), 'nodeMissing'],
    [
      'a Node.js path it will not quote',
      probe({ node: { path: "/opt/it's/node", version: 'v24.0.0', major: 24 } }),
      'nodeMissing',
    ],
    ['an old Node.js', probe({ node: { path: '/usr/bin/node', version: 'v22.9.0', major: 22 } }), 'nodeTooOld'],
    [
      'an unreadable Node.js version',
      probe({ node: { path: '/usr/bin/node', version: '', major: null } }),
      'nodeTooOld',
    ],
  ])('refuses %s', (_name, machine, kind) => {
    expect(installBlocker(machine, 'box')?.kind).toBe(kind);
  });
});
