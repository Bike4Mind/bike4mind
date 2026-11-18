import React from 'react';
import { render } from 'ink';
import { FullscreenOutput } from './components/FullscreenOutput.js';
import { sanitizeTerminalText } from './utils/sanitizeTerminalText.js';

export function fullscreenEnabled(
  requested = process.env.B4M_FULLSCREEN === '1',
  stdout: NodeJS.WriteStream = process.stdout,
  stdin: NodeJS.ReadStream = process.stdin
): boolean {
  return requested && !!stdout.isTTY && !!stdin.isTTY;
}

export function renderFullscreen(
  node: React.ReactNode,
  stdout: NodeJS.WriteStream = process.stdout,
  stdin: NodeJS.ReadStream = process.stdin
) {
  let capturedOutput = '';
  const onOutput = (output: string) => {
    capturedOutput = output;
  };
  // Debug output is a complete frame, not a cursor diff based on pre-resize rows.
  const frameStream = new Proxy(stdout, {
    get(target, key) {
      if (key === 'write') {
        return (chunk: string, callback?: (error?: Error | null) => void) => {
          if (chunk === '') return target.write('', callback);
          if (chunk === '\u001b[?1049l') {
            const diagnostics = capturedOutput ? sanitizeTerminalText(capturedOutput) + '\n' : '';
            capturedOutput = '';
            return target.write(chunk + diagnostics, callback);
          }
          // Input cleanup and cursor visibility are not render frames.
          // eslint-disable-next-line no-control-regex
          if (/^(?:\u001b\[\?[0-9;]+[hl])+$/.test(chunk)) {
            return target.write(chunk, callback);
          }
          if (chunk === '\n') return target.write('', callback);
          return target.write('\u001b[H\u001b[2J' + chunk, callback);
        };
      }
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return render(React.createElement(FullscreenOutput, { onOutput, children: node }), {
    stdout: frameStream,
    stdin,
    debug: true,
    interactive: true,
    alternateScreen: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
}
