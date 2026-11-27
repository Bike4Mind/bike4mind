// Writes the live tutorial edits an admin exported from the Tutorials tab back into the repo module, or a made
// tutorial's export into a new module directory.
//
//   pnpm --filter client tutorials:apply <bundle.json> [--dry-run] [--guard]
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runApplyCli } from '../server/tutorials/apply/cli';
import { coreLayout } from '../server/tutorials/apply/coreLayout';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

runApplyCli(coreLayout(ROOT), process.argv.slice(2)).then(code => process.exit(code));
