import { describe, expect, it } from 'vitest';
import {
  activateScript,
  installScript,
  isUsableNodePath,
  launcherScript,
  type InstallScriptInput,
} from './remoteScripts';

const input = (overrides: Partial<InstallScriptInput> = {}): InstallScriptInput => ({
  version: '1.2.3',
  sha256: 'a'.repeat(64),
  nodePath: '/usr/local/bin/node',
  token: '0123456789abcdef',
  payloadLines: ['SGVsbG8='],
  ...overrides,
});

describe('isUsableNodePath', () => {
  it.each(['/usr/bin/node', '/Users/me/Library/Application Support/fnm/node-versions/v24.1.0/installation/bin/node'])(
    'accepts %s',
    path => expect(isUsableNodePath(path)).toBe(true)
  );

  it.each(['node', "/opt/it's/node", '/opt/$(id)/node', '/opt/node\nrm', '/opt/`x`', `/${'a'.repeat(1024)}`])(
    'refuses %j',
    path => expect(isUsableNodePath(path)).toBe(false)
  );
});

describe('installScript', () => {
  it('places only the checked values, single-quoted', () => {
    const script = installScript(input());
    expect(script).toContain("V='1.2.3'");
    expect(script).toContain("NODE='/usr/local/bin/node'");
    expect(script).toContain(`SHA='${'a'.repeat(64)}'`);
    expect(script).toContain("TOKEN='0123456789abcdef'");
  });

  it.each<[string, Partial<InstallScriptInput>]>([
    ['a version that is not one', { version: "1.0.0'; rm -rf ~; '" }],
    ['a node path with a quote', { nodePath: "/opt/x'/node" }],
    ['a sha256 that is not hex', { sha256: 'z'.repeat(64) }],
    ['a short token', { token: 'abc' }],
    ['a payload line that is not base64', { payloadLines: ['B4M_PAYLOAD_END\nrm -rf ~'] }],
    ['a payload line that is too long', { payloadLines: ['A'.repeat(77)] }],
    ['a negative lock wait', { lockWaitSeconds: -1 }],
  ])('refuses %s', (_name, overrides) => {
    expect(() => installScript(input(overrides))).toThrow();
  });
});

describe('activateScript', () => {
  const locked = { version: '1.2.3', nodePath: '/usr/local/bin/node', token: '0123456789abcdef' };

  it('switches the launcher without uploading anything', () => {
    const script = activateScript(locked);
    expect(script).toContain("V='1.2.3'");
    expect(script).not.toContain('B4M_PAYLOAD_END');
    expect(script).toContain('phase activating');
  });

  it('refuses a version that is not one', () => {
    expect(() => activateScript({ ...locked, version: '1.2.3.tmp' })).toThrow();
  });
});

describe('installScript activate option', () => {
  it('leaves the launcher alone when told not to activate', () => {
    expect(installScript(input({ activate: false }))).not.toContain('phase activating');
    expect(installScript(input())).toContain('phase activating');
  });
});

describe('launcherScript', () => {
  it('runs the named build with the absolute node path', () => {
    expect(launcherScript('1.2.3', '/usr/bin/node')).toContain(
      'exec "$node" "$HOME/.b4m/host/versions/"\'1.2.3\'"/b4m-host.cjs" "$@"'
    );
  });
});
