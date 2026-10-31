import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { render } from 'ink-testing-library';
import { InputPrompt } from './InputPrompt';
import { useCliStore } from '../store';
import { CommandHistoryStore } from '../storage/CommandHistoryStore';
import type { CommandDefinition } from '../config/commands';

const UP = '\u001b[A';
const DOWN = '\u001b[B';
const commands = [
  { name: 'help', description: 'Show help' },
  { name: 'exit', description: 'Exit' },
] as CommandDefinition[];

let dir: string;

const tick = () => new Promise(resolve => setImmediate(resolve));
const inputValue = () => useCliStore.getState().inputValue;

async function press(stdin: { write: (data: string) => void }, key: string) {
  stdin.write(key);
  await tick();
}

async function type(stdin: { write: (data: string) => void }, text: string) {
  for (const char of text) await press(stdin, char);
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'b4m-input-history-'));
  useCliStore.setState({ inputValue: '', pastedContent: null, pastedLineCount: 0 });
});

afterEach(async () => {
  useCliStore.setState({ inputValue: '', pastedContent: null, pastedLineCount: 0 });
  await fs.rm(dir, { recursive: true, force: true });
});

describe('InputPrompt history', () => {
  it('recalls the previous session with Up and walks back with Down', async () => {
    const file = path.join(dir, 'history.jsonl');
    const previous = new CommandHistoryStore(file, { persist: true });
    await previous.load();
    previous.add('first message');
    previous.add('/help');
    previous.add('two\nlines');
    await previous.whenIdle();

    const history = await new CommandHistoryStore(file, { persist: true }).load();
    const { stdin, unmount } = render(<InputPrompt onSubmit={vi.fn()} history={history} commands={commands} />);
    await tick();

    await press(stdin, UP);
    await vi.waitFor(() => expect(inputValue()).toBe('two\nlines'));
    await press(stdin, UP);
    await vi.waitFor(() => expect(inputValue()).toBe('/help'));
    // A recalled slash command must not hand Up over to the command picker.
    await press(stdin, UP);
    await vi.waitFor(() => expect(inputValue()).toBe('first message'));
    await press(stdin, DOWN);
    await vi.waitFor(() => expect(inputValue()).toBe('/help'));
    await press(stdin, DOWN);
    await press(stdin, DOWN);
    await vi.waitFor(() => expect(inputValue()).toBe(''));
    unmount();
  });

  it('reports chat, slash and bash input exactly as typed', async () => {
    const onHistoryEntry = vi.fn();
    const onSubmit = vi.fn();
    const onBashCommand = vi.fn();
    const { stdin, unmount } = render(
      <InputPrompt
        onSubmit={onSubmit}
        onBashCommand={onBashCommand}
        onHistoryEntry={onHistoryEntry}
        commands={commands}
      />
    );
    await tick();

    await type(stdin, 'hello @nowhere ');
    await press(stdin, '\r');
    await type(stdin, '/help');
    await press(stdin, '\r');
    await type(stdin, '!ls -la');
    await press(stdin, '\r');

    await vi.waitFor(() =>
      expect(onHistoryEntry.mock.calls.map(call => call[0])).toEqual(['hello @nowhere ', '/help', '!ls -la'])
    );
    expect(onBashCommand).toHaveBeenCalledWith('ls -la');
    unmount();
  });

  it('reports a Tab follow-up queued while a turn runs', async () => {
    useCliStore.setState({ isThinking: true, turnInFlight: true });
    const onHistoryEntry = vi.fn();
    const onSubmit = vi.fn();
    try {
      const { stdin, unmount } = render(
        <InputPrompt onSubmit={onSubmit} onHistoryEntry={onHistoryEntry} commands={commands} />
      );
      await tick();

      await type(stdin, 'then the changelog');
      await press(stdin, '\t');

      await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledWith('then the changelog', { followUp: true }));
      expect(onHistoryEntry).toHaveBeenCalledWith('then the changelog');
      unmount();
    } finally {
      useCliStore.setState({ isThinking: false, turnInFlight: false });
    }
  });

  it('reports a pasted block and leaves history navigation at the start', async () => {
    const onHistoryEntry = vi.fn();
    const onSubmit = vi.fn();
    const { stdin, unmount } = render(
      <InputPrompt
        onSubmit={onSubmit}
        onHistoryEntry={onHistoryEntry}
        history={['newest', 'older']}
        commands={commands}
      />
    );
    await tick();

    await press(stdin, UP);
    await vi.waitFor(() => expect(inputValue()).toBe('newest'));
    useCliStore.getState().setPastedContent('pasted line one\npasted line two', 2);
    await tick();
    await press(stdin, '\r');

    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledWith('pasted line one\npasted line two'));
    expect(onHistoryEntry).toHaveBeenCalledWith('pasted line one\npasted line two');
    await press(stdin, UP);
    await vi.waitFor(() => expect(inputValue()).toBe('newest'));
    unmount();
  });
});
