import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Guards the one property a dry run of the lake embedding-space drain has to keep: it writes
 * nothing. The script's own dry-run tail prints "dry run: nothing written", and the manifest it
 * used to create before that refusal made the line false while dropping a file of fabFileIds,
 * userIds and file names onto the operator's disk for a rehearsal that changed no data.
 *
 * Mirrors checkDatalakeCensusReadOnly.test.ts: a source-level check, because the behaviour is an
 * ORDERING inside one function and no unit test of the pure planner can observe it.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SCRIPT_PATH = 'packages/scripts/migrate/drain-lake-embedding-space.ts';

// Comments are stripped first: the prose explaining why the write sits behind the gate names every
// token the assertions grep for, and would satisfy them on its own.
const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('the lake drain writes nothing on a dry run', () => {
  const code = stripComments(readFileSync(path.join(REPO_ROOT, SCRIPT_PATH), 'utf8'));

  // The refusal, not merely the call. `checkExpectedPopulation` returns a plan for BOTH outcomes,
  // so a script that consulted it and carried on would pass an assertion that only looked for the
  // call - and would still write the manifest on every dry run.
  const gateExit = code.search(/if\s*\(\s*!approved\.ok\s*\)\s*return\s+approved\.exitCode\s*;/);

  it('refuses a non-executing run before anything is written', () => {
    expect(gateExit).toBeGreaterThan(-1);
    expect(code).toMatch(/const\s+approved\s*=\s*checkExpectedPopulation\s*\(/);
    expect(code.indexOf('checkExpectedPopulation(')).toBeLessThan(gateExit);
  });

  // EVERY call site, not the first: a second write added above the gate would leave a first-match
  // check green while reintroducing the exact defect.
  it.each(['mkdtempSync', 'writeFileSync', 'appendFileSync', 'mkdirSync'])(
    'places every %s call after that refusal',
    method => {
      for (const call of code.matchAll(new RegExp(`\\b${method}\\s*\\(`, 'g'))) {
        expect(call.index).toBeGreaterThan(gateExit);
      }
    }
  );

  it('still writes the manifest on the execute path, which is not an undo but is the only record', () => {
    // The counterweight to the rule above. Deleting the manifest instead of moving it would pass
    // every ordering assertion here and destroy what an operator reads to finish a partial drain.
    expect(code).toMatch(/mkdtempSync\s*\(\s*path\.join\s*\(\s*os\.tmpdir\s*\(\s*\)\s*,\s*'lake-drain-'/);
    expect(code).toMatch(/-manifest\.json/);
  });

  it('keeps its artifacts out of the repo tree and owner-only', () => {
    expect(code).not.toMatch(/process\.cwd\(\)|__dirname|resolve\(\s*['"`]\.\.?['"`]/);
    const writes = [...code.matchAll(/\b(?:writeFileSync|appendFileSync)\s*\(/g)];
    expect(writes.length).toBeGreaterThan(0);
    for (const call of writes) {
      expect(code.slice(call.index, call.index! + 600)).toMatch(/mode:\s*0o600/);
    }
  });
});
