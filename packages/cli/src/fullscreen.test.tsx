import React from 'react';
import { PassThrough } from 'node:stream';
import { Text, render, useApp, useInput } from 'ink';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import xterm from '@xterm/headless';
import { App } from './components/App.js';
import { fullscreenEnabled, renderFullscreen } from './fullscreen.js';
import { useCliStore } from './store/index.js';
import { createMockSession } from './test-utils/mocks.js';

vi.mock('@bike4mind/utils/artifactParser', () => ({ parseArtifacts: () => [] }));
vi.mock('./utils/processFileReferences.js', () => ({ hasFileReferences: () => false }));

class Output extends PassThrough {
  isTTY = true;
  columns = 100;
  rows = 24;
}
class Input extends PassThrough {
  isTTY = true;
  raw = false;
  setRawMode(raw: boolean) {
    this.raw = raw;
    return this;
  }
  ref() {
    return this;
  }
  unref() {
    return this;
  }
}
const noop = () => {};
const asyncNoop = async () => {};

function ExitProbe() {
  const { exit } = useApp();
  useInput((input, key) => {
    if (key.ctrl && input === 'c') exit();
    if (input === 'e') exit(new Error('expected exit'));
  });
  return <Text>Exit probe</Text>;
}

async function harness(thinking = false, exitProbe = false) {
  const terminal = new xterm.Terminal({ cols: 100, rows: 24, scrollback: 1000, allowProposedApi: true });
  const stdout = new Output();
  const stdin = new Input();
  let bytes = '';
  stdout.on('data', chunk => {
    const text = String(chunk);
    bytes += text;
    terminal.write(text.replace(/\n/g, '\r\n'));
  });
  const flushTerminal = () => new Promise<void>(resolve => terminal.write('', resolve));
  stdout.write(Array.from({ length: 40 }, (_, i) => `SHELL_${i}\n`).join(''));
  await flushTerminal();
  const bufferText = (buffer = terminal.buffer.active) =>
    Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString(true)).join('\n');
  const shell = bufferText(terminal.buffer.normal);
  useCliStore.setState({ isThinking: thinking });
  const onMessage = vi.fn(asyncNoop);
  const instance = renderFullscreen(
    exitProbe ? (
      <ExitProbe />
    ) : (
      <App
        fullscreen
        onMessage={onMessage}
        onCommand={asyncNoop}
        onBashCommand={noop}
        onPermissionResponse={noop}
        onUserQuestionResponse={noop}
        onReviewGateResponse={noop}
      />
    ),
    stdout as unknown as NodeJS.WriteStream,
    stdin as unknown as NodeJS.ReadStream
  );
  const flush = async () => {
    await instance.waitUntilRenderFlush();
    await flushTerminal();
  };
  await flush();
  return {
    terminal,
    stdout,
    stdin,
    onMessage,
    instance,
    flush,
    bufferText,
    async resize(columns: number, rows: number) {
      terminal.resize(columns, rows);
      stdout.columns = columns;
      stdout.rows = rows;
      stdout.emit('resize');
      await flush();
    },
    async press(key: string) {
      stdin.write(key);
      await flush();
    },
    async close(error?: string) {
      instance.unmount();
      if (error) await expect(instance.waitUntilExit()).rejects.toThrow(error);
      else await instance.waitUntilExit();
      await flushTerminal();
      expect(terminal.buffer.active.type).toBe('normal');
      expect(bufferText(terminal.buffer.normal)).toBe(shell);
      expect(stdin.raw).toBe(false);
      expect(stdout.listenerCount('resize')).toBe(0);
      expect(bytes).not.toContain('\u001b[3J');
      terminal.dispose();
    },
  };
}

beforeEach(() => {
  useCliStore.setState({
    session: createMockSession({
      messages: [
        {
          id: 'done',
          role: 'assistant',
          content: 'COMPLETED_SENTINEL\n' + Array.from({ length: 50 }, (_, i) => `LINE_${i}`).join('\n'),
          timestamp: new Date(0).toISOString(),
        },
      ],
    }),
    isThinking: false,
    pendingMessages: [],
    messageQueue: [],
    inputValue: '',
    permissionPrompt: null,
    userQuestionPrompt: null,
    reviewGatePrompt: null,
  });
});

describe('explicit fullscreen', () => {
  it('requires opt-in and both TTY streams', () => {
    const ttyOut = { isTTY: true } as NodeJS.WriteStream;
    const ttyIn = { isTTY: true } as NodeJS.ReadStream;
    expect(fullscreenEnabled(false, ttyOut, ttyIn)).toBe(false);
    expect(fullscreenEnabled(true, ttyOut, ttyIn)).toBe(true);
    expect(fullscreenEnabled(true, {} as NodeJS.WriteStream, ttyIn)).toBe(false);
    expect(fullscreenEnabled(true, ttyOut, {} as NodeJS.ReadStream)).toBe(false);
  });

  it('normal non-TTY rendering emits plain final output without screen controls', async () => {
    const stdout = new Output();
    stdout.isTTY = false;
    const stdin = new Input();
    let output = '';
    stdout.on('data', chunk => {
      output += String(chunk);
    });
    const instance = render(<Text>piped output</Text>, {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    });
    instance.unmount();
    await instance.waitUntilExit();
    expect(output).toBe('piped output\n');
    expect(stdin.raw).toBe(false);
  });

  it.each(['interrupt', 'error'])('restores original screen and terminal state on %s', async kind => {
    const h = await harness(false, true);
    h.stdin.write(kind === 'error' ? 'e' : '\u0003');
    if (kind === 'error') await expect(h.instance.waitUntilExit()).rejects.toThrow('expected exit');
    else await h.instance.waitUntilExit();
    await h.close(kind === 'error' ? 'expected exit' : undefined);
  });

  it.each([false, true])('keeps a single live frame across bounded resizes (thinking=%s)', async thinking => {
    const h = await harness(thinking);
    try {
      for (let repeat = 0; repeat < 3; repeat++) {
        for (const [columns, rows] of [
          [60, 24],
          [100, 24],
          [40, 12],
          [120, 30],
          [80, 24],
        ]) {
          await h.resize(columns!, rows!);
          expect(h.bufferText().match(/Type your message/g)).toHaveLength(1);
          expect(h.bufferText().match(/Thinking/g) ?? []).toHaveLength(thinking ? 1 : 0);
          expect(h.terminal.buffer.active.type).toBe('alternate');
        }
      }
    } finally {
      await h.close();
    }
  });

  it('fixed-size control keeps a single Thinking row across updates', async () => {
    const h = await harness(true);
    try {
      for (let i = 0; i < 5; i++) {
        useCliStore.setState({ inputValue: `draft ${i}` });
        await h.flush();
        expect(h.bufferText().match(/Thinking/g)).toHaveLength(1);
      }
    } finally {
      await h.close();
    }
  });

  it('browses completed message lines and returns to working input', async () => {
    const h = await harness();
    try {
      await h.press('\u000f');
      expect(h.bufferText()).toContain('COMPLETED_SENTINEL');
      await h.press('\u001b[6~');
      expect(h.bufferText()).toContain('LINE_30');
      await h.press('\u000f');
      await h.press('hello');
      await h.press('\r');
      expect(h.onMessage).toHaveBeenCalledWith('hello');
    } finally {
      await h.close();
    }
  });

  it('retains console command output across redraws and restores console methods on exit', async () => {
    const originalLog = console.log;
    const h = await harness();
    try {
      console.log('COMMAND_HELP_SENTINEL %s', 'formatted');
      console.error('COMMAND_ERROR_SENTINEL');
      await h.flush();
      await h.resize(40, 12);
      await h.press('\u000f');
      expect(h.bufferText()).toContain('COMMAND_HELP_SENTINEL formatted');
      expect(h.bufferText()).toContain('COMMAND_ERROR_SENTINEL');
      console.log('x'.repeat(70 * 1024));
      console.warn('RETAINED_TAIL');
      await h.flush();
      await h.press('\u001b[6~');
    } finally {
      await h.close();
    }
    expect(console.log).toBe(originalLog);
  });

  it('reaches older messages, wrapped text and completed steps after a resize', async () => {
    const session = useCliStore.getState().session!;
    useCliStore.setState({
      session: {
        ...session,
        messages: [
          {
            id: 'older',
            role: 'user',
            content: 'prefix '.repeat(50) + 'WRAPPED_END',
            timestamp: new Date(0).toISOString(),
            metadata: { steps: [{ type: 'thought', content: 'STEP_SENTINEL', metadata: { timestamp: 0 } }] },
          },
          ...session.messages,
        ],
      },
    });
    const h = await harness();
    try {
      await h.press('\u000f');
      await h.press('\u001b[D');
      await h.resize(40, 12);
      await h.press('\u001b[6~');
      expect(h.bufferText()).toContain('WRAPPED_END');
      expect(h.bufferText().replace(/\n/g, '')).toContain('STEP_SENTINEL');
      await h.press('\u001b[C');
      expect(h.bufferText()).toContain('COMPLETED_SENTINEL');
    } finally {
      await h.close();
    }
  });
});
