import { spawn as nodeSpawn } from 'child_process';

/** `clipboard`: a platform tool confirmed the copy. `terminal`: only OSC 52 was sent, which some terminals ignore. */
export type CopyResult = 'clipboard' | 'terminal' | 'failed';

export interface CopyDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Writes to the controlling terminal; return false when there is none. */
  writeTerminal?: (data: string) => boolean;
  spawn?: typeof nodeSpawn;
  timeoutMs?: number;
}

export function osc52(text: string): string {
  return `\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`;
}

export function isSshSession(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.SSH_CONNECTION || env.SSH_TTY);
}

const X_TOOLS: Array<[string, string[]]> = [
  ['xclip', ['-selection', 'clipboard']],
  ['xsel', ['--clipboard', '--input']],
];

/**
 * Clipboard commands to try, in order. Over SSH only a DISPLAY with a host part (`ssh -X` sets
 * `localhost:10.0`) can reach the user's own screen; any other tool would fill the remote host's clipboard.
 */
export function clipboardCommands(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): Array<[string, string[]]> {
  if (isSshSession(env)) {
    const display = env.DISPLAY ?? '';
    const hasHost = display.indexOf(':') > 0 && !display.startsWith('unix:');
    return hasHost ? X_TOOLS : [];
  }
  if (platform === 'darwin') return [['pbcopy', []]];
  if (platform === 'win32') return [['clip', []]];
  const display: Array<[string, string[]]> = [];
  if (env.WAYLAND_DISPLAY) display.push(['wl-copy', []]);
  if (env.DISPLAY) display.push(...X_TOOLS);
  if (env.WSL_DISTRO_NAME) display.push(['clip.exe', []]);
  return display;
}

function runTool(
  spawn: typeof nodeSpawn,
  command: string,
  args: string[],
  text: string,
  timeoutMs: number
): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    // The text goes over stdin, never argv, so it does not show up in process listings.
    const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    const timer = setTimeout(() => {
      child.kill();
      done(false);
    }, timeoutMs);
    child.on('error', () => done(false));
    // 'exit', not 'close': xclip and wl-copy fork a child that keeps serving the selection.
    child.on('exit', code => done(code === 0));
    child.stdin?.on('error', () => done(false));
    child.stdin?.end(text);
  });
}

function defaultWriteTerminal(data: string): boolean {
  if (!process.stdout.isTTY) return false;
  process.stdout.write(data);
  return true;
}

/**
 * Locally the platform tool goes first and OSC 52 is the fallback. Over SSH OSC 52 goes first,
 * since it is what reaches the user's terminal.
 */
export async function copyToClipboard(text: string, deps: CopyDeps = {}): Promise<CopyResult> {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const spawn = deps.spawn ?? nodeSpawn;
  const writeTerminal = deps.writeTerminal ?? defaultWriteTerminal;
  const timeoutMs = deps.timeoutMs ?? 2000;

  const sendOsc52 = () => {
    try {
      return writeTerminal(osc52(text));
    } catch {
      return false;
    }
  };

  const sentFirst = isSshSession(env) && sendOsc52();
  for (const [command, args] of clipboardCommands(platform, env)) {
    try {
      if (await runTool(spawn, command, args, text, timeoutMs)) return 'clipboard';
    } catch {
      // A synchronous spawn failure means this tool is unusable; try the next one.
    }
  }
  const sent = isSshSession(env) ? sentFirst : sendOsc52();
  return sent ? 'terminal' : 'failed';
}
