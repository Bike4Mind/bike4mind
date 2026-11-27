import { describe, expect, it } from 'vitest';
import { isValidSshAlias, parseSshG, REMOTE_CONNECT_COMMAND, requireSshAlias, sshConnectArgs } from './sshCommand';

describe('isValidSshAlias', () => {
  it.each(['devbox', 'devbox.local', 'me@devbox', 'build-01', 'gpu_box', '10.0.0.7', 'A'])('accepts %s', alias => {
    expect(isValidSshAlias(alias)).toBe(true);
  });

  it.each([
    ['an option', '-oProxyCommand=sh -c id'],
    ['a long option', '--help'],
    ['the end of options', '--'],
    ['a lone dash', '-'],
    ['a leading dot', '.hidden'],
    ['a leading at', '@devbox'],
    ['a space', 'dev box'],
    ['a newline', 'devbox\n-oProxyCommand=id'],
    ['a semicolon', 'devbox;id'],
    ['a command substitution', 'devbox$(id)'],
    ['backticks', '`id`'],
    ['a quote', "devbox'"],
    ['a pattern', 'dev*'],
    ['a negation', '!devbox'],
    ['a slash', 'dev/box'],
    ['a colon', 'devbox:22'],
    ['non-ASCII', 'd\u00e9vbox'],
    ['nothing', ''],
    ['too long', 'a'.repeat(256)],
  ])('refuses %s', (_what, alias) => {
    expect(isValidSshAlias(alias)).toBe(false);
  });

  it('requireSshAlias refuses anything but a valid string', () => {
    expect(requireSshAlias('devbox')).toBe('devbox');
    expect(() => requireSshAlias(['devbox'])).toThrow('Not an SSH host alias');
    expect(() => requireSshAlias('-oProxyCommand=id')).toThrow('Not an SSH host alias');
  });
});

describe('sshConnectArgs', () => {
  it('passes the alias after -- and runs only the fixed remote command', () => {
    const args = sshConnectArgs('devbox', 'darwin');
    expect(args).toEqual([
      '-T',
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=10',
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=3',
      '-o',
      'ControlMaster=auto',
      '-o',
      'ControlPath=~/.b4m/desktop/cm/%C',
      '-o',
      'ControlPersist=60',
      '--',
      'devbox',
      REMOTE_CONNECT_COMMAND,
    ]);
    expect(REMOTE_CONNECT_COMMAND).toBe('exec "$HOME/.b4m/host/bin/b4m-host" connect');
  });

  it('never overrides host key checking', () => {
    expect(sshConnectArgs('devbox', 'linux').join(' ')).not.toMatch(/StrictHostKeyChecking|UserKnownHostsFile/i);
  });

  it('leaves multiplexing out on Windows, whose OpenSSH has none', () => {
    const args = sshConnectArgs('devbox', 'win32');
    expect(args.join(' ')).not.toContain('Control');
    expect(args.slice(-3)).toEqual(['--', 'devbox', REMOTE_CONNECT_COMMAND]);
  });

  it('refuses an alias that is not valid before building anything', () => {
    expect(() => sshConnectArgs('-oProxyCommand=id', 'linux')).toThrow('Not an SSH host alias');
  });
});

describe('parseSshG', () => {
  it('reads hostname, user and port', () => {
    const output = 'host devbox\nhostname devbox.example.test\nuser rider\nport 2222\nidentityfile ~/.ssh/id_ed25519\n';
    expect(parseSshG('devbox', output)).toEqual({
      alias: 'devbox',
      hostname: 'devbox.example.test',
      user: 'rider',
      port: 2222,
    });
  });

  it('falls back to the alias and port 22 when ssh leaves them out', () => {
    expect(parseSshG('devbox', 'port nope\n')).toEqual({ alias: 'devbox', hostname: 'devbox', user: '', port: 22 });
  });
});
