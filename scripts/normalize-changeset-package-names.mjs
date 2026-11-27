#!/usr/bin/env node
// Rewrites retired package names in pending changesets before `changeset version` reads them.
//
// A changeset is written on its PR branch, so a branch cut before a package was renamed carries
// the old name, and `changeset version` aborts on a name that is not in the workspace. This runs
// inside the `changeset:version` script, not as a workflow step: the release action resets the
// working tree before it calls that script, which discards anything a prior step changed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Delete an entry once no open branch predates its rename, and this script once the map is empty.
export const RENAMED = { '@bike4mind/services': '@bike4mind/services-core' };

/** Returns `text` with retired names replaced in the frontmatter only. */
export function normalize(text) {
  const match = text.match(/^((?:<!--.*-->\s*)?\s*---\r?\n)(?:([\s\S]*?)\r?\n)??(\s*---)/);
  if (!match) return text;
  const body = match[2] ?? '';
  const frontmatter = body
    .split('\n')
    .map(line => {
      const key = line.match(/^(["']?)([^"':]+?)\1\s*:/);
      return key && Object.hasOwn(RENAMED, key[2]) ? line.replace(key[2], RENAMED[key[2]]) : line;
    })
    .join('\n');
  return match[1] + frontmatter + text.slice(match[1].length + body.length);
}

export function main(dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.changeset')) {
  for (const file of fs.readdirSync(dir).filter(name => name.endsWith('.md') && name !== 'README.md')) {
    const full = path.join(dir, file);
    const before = fs.readFileSync(full, 'utf8');
    const after = normalize(before);
    if (after !== before) {
      fs.writeFileSync(full, after);
      console.log(`normalized package names in .changeset/${file}`);
    }
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) main();
