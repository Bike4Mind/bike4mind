/**
 * Reads the markdown corpus from source for the live driver. Kept out of `index.ts` so the
 * published subpath never pulls in node:fs.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { CorpusDoc } from './provision';

const SUPERSEDED = 'superseded';

function markdownIn(dir: string): string[] {
  return readdirSync(dir)
    .filter(name => name.endsWith('.md'))
    .sort();
}

/** `root` is the `corpus` directory: one folder per subject, older generations under `superseded/`. */
export function readLakeRagCorpus(root: string): CorpusDoc[] {
  const docs: CorpusDoc[] = [];
  const subjects = readdirSync(root)
    .filter(name => statSync(join(root, name)).isDirectory())
    .sort();
  for (const subject of subjects) {
    const dir = join(root, subject);
    const supersededDir = join(dir, SUPERSEDED);
    if (existsSync(supersededDir)) {
      for (const fileName of markdownIn(supersededDir)) {
        docs.push({
          subject,
          fileName,
          generation: 'superseded',
          body: readFileSync(join(supersededDir, fileName), 'utf8'),
        });
      }
    }
    for (const fileName of markdownIn(dir)) {
      docs.push({ subject, fileName, generation: 'current', body: readFileSync(join(dir, fileName), 'utf8') });
    }
  }
  return docs;
}
