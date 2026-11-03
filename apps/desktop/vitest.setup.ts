import { mkdirSync, mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

/**
 * A temp root and home directory of this run's own, removed when the test file finishes.
 *
 * TMPDIR points at the root so every os.tmpdir() a test or the code under test creates a
 * directory in is swept with it; WSL's /tmp is a capped tmpfs that leaked directories fill.
 *
 * os.homedir() reports the home because it honours $HOME. The app reads ~/.claude/CLAUDE.md into
 * every session's system prompt, so without this the suite would load the instructions of whoever
 * happens to run it: assertions would depend on a file that is not in this repository, and the
 * time taken to read it would land in the timing of ChatService tests that have nothing to do
 * with instructions.
 */
const root = mkdtempSync(join(tmpdir(), 'b4m-desktop-test-'));
const home = join(root, 'home');
mkdirSync(home);
process.env.TMPDIR = root;
process.env.HOME = home;

afterAll(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
