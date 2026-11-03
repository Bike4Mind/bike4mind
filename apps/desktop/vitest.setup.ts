import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import { RUN_ROOT_ENV, redirectHomedir, redirectTmpdir, removeRoot } from './vitest.tempRoot';

// The app reads ~/.claude/CLAUDE.md into every session's prompt, so each file gets its own HOME.
// Parent is the run root, not tmpdir(): under --no-isolate tmpdir() is the previous file's deleted root.
const root = mkdtempSync(join(process.env[RUN_ROOT_ENV] ?? tmpdir(), 'b4m-desktop-test-'));
const home = join(root, 'home');
mkdirSync(home);
redirectTmpdir(root);
redirectHomedir(home);

afterAll(() => removeRoot(root));
