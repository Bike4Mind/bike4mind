/**
 * The debug logger turns the session id into a filename under
 * ~/.bike4mind/debug, so `initialize` validates the id at that sink. These tests
 * pin that guard: a valid id writes the file; a traversing id is rejected before
 * any write. Remove the guard in Logger.ts and the second test fails.
 *
 * Hermetic: os.homedir is mocked to an empty temp dir.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { Logger } from './Logger.js';

let fakeHome: string;

beforeEach(async () => {
  fakeHome = path.join(os.tmpdir(), `b4m-logger-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(fakeHome, { recursive: true });
  vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(fakeHome, { recursive: true, force: true }).catch(() => {});
});

describe('Logger.initialize session-id guard', () => {
  it('writes the debug file for a valid session id', async () => {
    await Logger.getInstance().initialize('valid-id');
    expect(existsSync(path.join(fakeHome, '.bike4mind', 'debug', 'valid-id.txt'))).toBe(true);
  });

  it('refuses a traversing session id', async () => {
    // The guard throws before the sink is touched, so asserting the throw is the
    // real signal; a "no file written" check would pass vacuously (the dir never
    // gets created) and prove nothing.
    await expect(Logger.getInstance().initialize('../../etc/evil')).rejects.toThrow(/Invalid session id/);
  });
});
