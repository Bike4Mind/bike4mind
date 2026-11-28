import { describe, expect, it, vi } from 'vitest';

// The host runs where Electron does not exist: loading any module under src/host, directly or
// through what it imports, must not reach it. Kept to every module rather than the entry points,
// so a module only a future entry point uses is covered the day it is added.
vi.mock('electron', () => {
  throw new Error('a module under src/host loaded electron');
});

// bin.ts runs the program as it loads, so it is checked through cli.ts, which it only calls.
const modules = import.meta.glob(['./**/*.ts', '!./**/*.test.ts', '!./**/__fixtures__/**', '!./headless/bin.ts']);

describe('src/host without Electron', () => {
  it('finds the modules it checks', () => {
    expect(Object.keys(modules)).toEqual(
      expect.arrayContaining(['./HostRuntime.ts', './server/HostServer.ts', './attachments/AttachmentUploads.ts'])
    );
  });

  // The first load transforms most of the runtime's import graph, which is slow on a busy machine.
  it.each(Object.keys(modules))(
    'loads %s',
    async path => {
      await expect(modules[path]()).resolves.toBeDefined();
    },
    120_000
  );
});
