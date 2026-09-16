import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * A `#` line inside a folded (`>`) block scalar is not a comment.
 *
 * YAML joins same-indentation lines of a folded block with a SPACE, so a `#` line lands
 * inline in the shell command it sits next to and comments out the rest of that line.
 * Every command after it silently stops running while the container still exits 0. A
 * literal (`|`) block is safe, because it preserves the newlines that make each `#` a
 * real comment - so this only flags folded blocks.
 *
 * Put the prose above the `- >` line instead, where the YAML parser really does treat it
 * as a comment.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

interface Offence {
  file: string;
  line: number;
  text: string;
}

/** Lines beginning a `>` block, then any `#` line at that block's own indentation. */
const foldedBlockComments = (source: string, file: string): Offence[] => {
  const lines = source.split('\n');
  const offences: Offence[] = [];

  for (let i = 0; i < lines.length; i++) {
    // `key: >`, `- >`, `>-`, `>+` - the chomping/indent indicators may follow.
    if (!/^\s*(?:-\s+|[\w.-]+:\s+)?>[-+0-9]*\s*$/.test(lines[i])) continue;

    const introIndent = lines[i].search(/\S/);
    let baseIndent: number | null = null;

    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === '') continue;
      const indent = line.search(/\S/);
      if (indent <= introIndent) break; // block ended
      if (baseIndent === null) baseIndent = indent;
      // A more-indented line keeps its own newlines, so a `#` there is a real comment.
      if (indent === baseIndent && line.trimStart().startsWith('#')) {
        offences.push({ file, line: j + 1, text: line.trim() });
      }
    }
  }

  return offences;
};

describe('compose files', () => {
  const files = readdirSync(REPO_ROOT).filter(f => /^compose.*\.ya?ml$/.test(f));

  it('finds compose files to scan, proving the scan is not vacuous', () => {
    expect(files).toContain('compose.selfhost.yaml');
  });

  it('has no comment line inside a folded block scalar', () => {
    const offences = files.flatMap(f => foldedBlockComments(readFileSync(path.join(REPO_ROOT, f), 'utf8'), f));

    expect(
      offences.map(o => `${o.file}:${o.line}  ${o.text}`),
      'A "#" line at the base indentation of a "> " block folds into the previous line and comments out the commands after it. Move the prose above the "- >" line.'
    ).toEqual([]);
  });
});
