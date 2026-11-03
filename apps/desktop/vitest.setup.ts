import { mkdirSync, mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import { redirectHomedir, redirectTmpdir } from './vitest.tempRoot';

/**
 * A temp root and home directory of this file's own, removed when the file finishes.
 * Everything created through os.tmpdir() lands in the root, so a run cannot fill /tmp.
 *
 * The app reads ~/.claude/CLAUDE.md into every session's system prompt, so without a home of our
 * own the suite would load the instructions of whoever runs it: assertions would depend on a file
 * outside this repository and ChatService timings would include reading it.
 */
const root = mkdtempSync(join(tmpdir(), 'b4m-desktop-test-'));
const home = join(root, 'home');
mkdirSync(home);
redirectTmpdir(root);
redirectHomedir(home);

afterAll(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
