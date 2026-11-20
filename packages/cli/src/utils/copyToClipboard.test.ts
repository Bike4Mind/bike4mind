import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { spawn as nodeSpawn } from 'child_process';
import { clipboardCommands, copyToClipboard, osc52 } from './copyToClipboard';

const LINK = 'https://app.example.com/activate?code=ABCD-1234';

type Outcome = { exit?: number; error?: boolean; hang?: boolean };

function fakeSpawn(outcomes: Record<string, Outcome>) {
  const calls: Array<{ command: string; args: string[]; stdin: string; kill: ReturnType<typeof vi.fn> }> = [];
  const spawn = vi.fn((command: string, args: string[]) => {
    const kill = vi.fn();
    const child = Object.assign(new EventEmitter(), { kill }) as EventEmitter & {
      kill: typeof kill;
      stdin: EventEmitter & { end: (s: string) => void };
    };
    const call = { command, args, stdin: '', kill };
    calls.push(call);
    child.stdin = Object.assign(new EventEmitter(), {
      end: (s: string) => {
        call.stdin = s;
      },
    });
    const outcome = outcomes[command] ?? { error: true };
    setImmediate(() => {
      if (outcome.hang) return;
      if (outcome.error) child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
      else child.emit('exit', outcome.exit ?? 0);
    });
    return child;
  });
  return { spawn: spawn as unknown as typeof nodeSpawn, calls };
}

describe('osc52', () => {
  it('base64-encodes the text into a clipboard set sequence', () => {
    expect(osc52(LINK)).toBe(`\x1b]52;c;${Buffer.from(LINK).toString('base64')}\x07`);
  });
});

describe('clipboardCommands', () => {
  it('uses the native tool on macOS and Windows', () => {
    expect(clipboardCommands('darwin', {})).toEqual([['pbcopy', []]]);
    expect(clipboardCommands('win32', {})).toEqual([['clip', []]]);
  });

  it('picks Wayland, then X11 tools on Linux from the session env', () => {
    expect(clipboardCommands('linux', { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }).map(([c]) => c)).toEqual([
      'wl-copy',
      'xclip',
      'xsel',
    ]);
    expect(clipboardCommands('linux', {})).toEqual([]);
  });

  it('tries clip.exe after the display tools under WSL', () => {
    expect(clipboardCommands('linux', { WSL_DISTRO_NAME: 'Ubuntu' })).toEqual([['clip.exe', []]]);
    expect(clipboardCommands('linux', { WSL_DISTRO_NAME: 'Ubuntu', DISPLAY: ':0' }).map(([c]) => c)).toEqual([
      'xclip',
      'xsel',
      'clip.exe',
    ]);
  });

  it('over SSH keeps only X tools on a forwarded display', () => {
    expect(clipboardCommands('darwin', { SSH_CONNECTION: '1 2 3 4' })).toEqual([]);
    expect(clipboardCommands('linux', { SSH_TTY: '/dev/pts/1', DISPLAY: ':0' })).toEqual([]);
    expect(clipboardCommands('linux', { SSH_TTY: '/dev/pts/1', DISPLAY: 'unix:0' })).toEqual([]);
    expect(clipboardCommands('linux', { SSH_TTY: '/dev/pts/1', WAYLAND_DISPLAY: 'wayland-0' })).toEqual([]);
    expect(
      clipboardCommands('linux', {
        SSH_TTY: '/dev/pts/1',
        DISPLAY: 'localhost:10.0',
        WAYLAND_DISPLAY: 'wayland-0',
      }).map(([c]) => c)
    ).toEqual(['xclip', 'xsel']);
  });
});

describe('copyToClipboard', () => {
  it('locally uses the native tool and skips OSC 52 when it succeeds, passing the text on stdin only', async () => {
    const { spawn, calls } = fakeSpawn({ pbcopy: { exit: 0 } });
    const writeTerminal = vi.fn(() => true);
    await expect(copyToClipboard(LINK, { platform: 'darwin', env: {}, spawn, writeTerminal })).resolves.toBe(
      'clipboard'
    );
    expect(writeTerminal).not.toHaveBeenCalled();
    expect(calls.map(({ command, args, stdin }) => ({ command, args, stdin }))).toEqual([
      { command: 'pbcopy', args: [], stdin: LINK },
    ]);
  });

  it('locally falls back to OSC 52 after the native tool fails', async () => {
    const { spawn } = fakeSpawn({ pbcopy: { exit: 1 } });
    const order: string[] = [];
    const writeTerminal = vi.fn(() => {
      order.push('osc52');
      return true;
    });
    const tracked = vi.fn((...args: Parameters<typeof nodeSpawn>) => {
      order.push('tool');
      return spawn(...args);
    }) as unknown as typeof nodeSpawn;
    const result = await copyToClipboard(LINK, { platform: 'darwin', env: {}, spawn: tracked, writeTerminal });
    expect(result).toBe('terminal');
    expect(order).toEqual(['tool', 'osc52']);
  });

  it('falls through to the next tool when one is missing', async () => {
    const { spawn, calls } = fakeSpawn({ xsel: { exit: 0 } });
    const result = await copyToClipboard(LINK, {
      platform: 'linux',
      env: { DISPLAY: ':0' },
      spawn,
      writeTerminal: () => false,
    });
    expect(result).toBe('clipboard');
    expect(calls.map(c => c.command)).toEqual(['xclip', 'xsel']);
  });

  it('reaches clip.exe under WSL when the display tools fail', async () => {
    const { spawn, calls } = fakeSpawn({ xclip: { exit: 1 }, 'clip.exe': { exit: 0 } });
    const result = await copyToClipboard(LINK, {
      platform: 'linux',
      env: { WSL_DISTRO_NAME: 'Ubuntu', DISPLAY: ':0' },
      spawn,
      writeTerminal: () => true,
    });
    expect(result).toBe('clipboard');
    expect(calls.map(c => c.command)).toEqual(['xclip', 'xsel', 'clip.exe']);
  });

  it('over SSH sends OSC 52 first and reports terminal when no forwarded tool works', async () => {
    const order: string[] = [];
    const { spawn } = fakeSpawn({ xclip: { exit: 1 } });
    const tracked = vi.fn((...args: Parameters<typeof nodeSpawn>) => {
      order.push('tool');
      return spawn(...args);
    }) as unknown as typeof nodeSpawn;
    const result = await copyToClipboard(LINK, {
      platform: 'linux',
      env: { SSH_TTY: '/dev/pts/1', DISPLAY: 'localhost:10.0' },
      spawn: tracked,
      writeTerminal: () => {
        order.push('osc52');
        return true;
      },
    });
    expect(result).toBe('terminal');
    expect(order).toEqual(['osc52', 'tool', 'tool']);
  });

  it('over SSH with a remote-local display never reports clipboard', async () => {
    const { spawn, calls } = fakeSpawn({ xclip: { exit: 0 } });
    const result = await copyToClipboard(LINK, {
      platform: 'linux',
      env: { SSH_TTY: '/dev/pts/1', DISPLAY: ':0' },
      spawn,
      writeTerminal: () => true,
    });
    expect(result).toBe('terminal');
    expect(calls).toEqual([]);
  });

  it('kills a tool that does not exit in time and reports failed with no terminal', async () => {
    const { spawn, calls } = fakeSpawn({ xclip: { hang: true }, xsel: { hang: true } });
    const writeTerminal = vi.fn(() => {
      throw new Error('EPIPE');
    });
    const result = await copyToClipboard(LINK, {
      platform: 'linux',
      env: { DISPLAY: ':0' },
      spawn,
      writeTerminal,
      timeoutMs: 10,
    });
    expect(result).toBe('failed');
    expect(calls.map(c => c.command)).toEqual(['xclip', 'xsel']);
    for (const call of calls) expect(call.kill).toHaveBeenCalledTimes(1);
  });
});
