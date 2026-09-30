import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A home directory of this run's own, which os.homedir() reports because it honours $HOME.
 *
 * The app reads ~/.claude/CLAUDE.md into every session's system prompt, so without this the
 * suite would load the instructions of whoever happens to run it: assertions would depend on a
 * file that is not in this repository, and the time taken to read it would land in the timing
 * of ChatService tests that have nothing to do with instructions.
 */
process.env.HOME = mkdtempSync(join(tmpdir(), 'b4m-desktop-home-'));
