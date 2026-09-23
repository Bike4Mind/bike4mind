/**
 * @vitest-environment node
 *
 * MCP_VERSION and HELP_CORPUS_VERSION exist because SST does not notice copyFiles CONTENT changes:
 * each hashes the sources its Lambda carries, so a content-only edit still redeploys the function.
 * Each hash reads a hand-written list of inputs declared a few dozen lines from the copyFiles list
 * it tracks, with nothing but a comment tying the two together.
 *
 * A source copied but missing from the hash inputs yields a version that is non-empty, valid, and
 * simply does not cover it. The per-input emptiness checks in @bike4mind/infra cannot see that,
 * and neither can a preview deploy - the Lambda keeps serving previous code.
 *
 * Text-matched, not executed: infra/ is an SST program and does not load outside `sst`. The
 * literals read here are the ones it evaluates.
 *
 * Both literal lists stay hand-written on purpose. Deriving one from the other would delete the
 * per-entry comments recording why a given package is copied, which is the context that makes the
 * lists readable at all.
 *
 * What a hashed path actually covers: the copied `<pkg>/dist` directories are gitignored, so the
 * hash reads each package's tracked SOURCE instead. That is a proxy - source is what changes when
 * dist changes - not a digest of the bytes that ship. What follows asserts the two hand-written
 * lists correspond; it cannot prove the bundle's bytes are in the hash.
 *
 * NOT covered, deliberately: that every entry for a package is present. A package keeps its hashed
 * prefix satisfied as long as ONE entry survives, so dropping `<pkg>/dist` while
 * `<pkg>/package.json` remains stays green here. That is a module-resolution bug rather than a
 * staleness one and wants its own guard.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), 'utf8');

/** Whether git has any blob under `entry`, which is what decides if the hash can see it at all. */
const tracked = (entry: string) =>
  execFileSync('git', ['ls-tree', '-r', 'HEAD', entry], { cwd: REPO_ROOT, encoding: 'utf8' }).trim().length > 0;

/**
 * Drops comments while leaving string literals intact, in one pass so an apostrophe in prose
 * ("it is") reads as comment text rather than opening a string. Neither file contains a regex
 * literal, which is the one construct this cannot tell from a division operator; the scanner's
 * own behaviour is pinned at the bottom of this file.
 */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === '//') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    const quote = source[i];
    if (quote === '"' || quote === "'" || quote === '`') {
      out += source[i++];
      while (i < source.length) {
        if (source[i] === '\\') {
          out += source.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += source[i];
        if (source[i++] === quote) break;
      }
      continue;
    }
    out += source[i++];
  }
  return out;
}

/**
 * The sole match for `anchor`, asserted unique rather than merely present.
 *
 * `indexOf` returning -1 degrades to "search from the start", which is how a guard like this one
 * goes quietly green after the declaration it reads is renamed - the same silent-drift failure it
 * exists to prevent, one level up. Two matches are equally loud, so a second copyFiles list in
 * either declaration has to be read rather than skipped. Each anchor is matched against the
 * declaration slice, not the whole file, so an unrelated Lambda gaining copyFiles stays quiet.
 */
function soleMatch(source: string, anchor: RegExp, what: string): RegExpExecArray {
  const matches = [...source.matchAll(anchor)];
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${what}, found ${matches.length}. Point this guard at the new shape.`);
  }
  return matches[0] as RegExpExecArray;
}

/**
 * Slice from the first `open` at or after `startIndex` through its matching close. Runs on
 * comment-stripped source; no path literal in either file contains a bracket or brace.
 */
function balanced(source: string, startIndex: number, open: string, close: string): string {
  const start = source.indexOf(open, startIndex);
  if (start === -1) throw new Error(`No ${open} after index ${startIndex}`);
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === open) depth++;
    else if (source[i] === close && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`Unbalanced ${open} starting at index ${start}`);
}

const quoted = () => /(['"`])([^'"`]*)\1/g;

/**
 * String literals of an array literal, with the leftovers checked. A spread or an identifier in
 * the list would otherwise just be absent from the extracted set, which reads here as "nothing
 * drifted" - a silent pass, the failure this guard exists to make loud.
 */
export function arrayLiterals(arrayLiteral: string, what: string): string[] {
  const residue = arrayLiteral.replace(quoted(), '').trim();
  if (!/^\[[\s,]*\]$/.test(residue)) {
    throw new Error(`${what} holds something other than string literals: ${residue}`);
  }
  return [...arrayLiteral.matchAll(quoted())].map(match => match[2]);
}

/**
 * `from:` sources of a copyFiles array. Counted against the number of `from:` keys so an entry
 * this cannot parse - a double-quoted path, a template literal, a variable - fails loudly rather
 * than going missing from the comparison, where its absence would read as agreement.
 */
export function copiedFrom(copyFilesList: string): string[] {
  const keys = copyFilesList.match(/\bfrom:/g)?.length ?? 0;
  const values = [...copyFilesList.matchAll(/\bfrom:\s*(['"`])([^'"`]*)\1/g)].map(match => match[2]);
  if (values.length !== keys) {
    throw new Error(`copyFiles has ${keys} \`from:\` keys but ${values.length} parse as string literals.`);
  }
  return values;
}

/** The hashed path covering `source`, either exactly or as a parent directory. */
const coveringPath = (source: string, hashed: readonly string[]) =>
  hashed.find(candidate => source === candidate || source.startsWith(`${candidate}/`));

describe('MCP_VERSION covers every workspace package the MCP bundle carries', () => {
  /**
   * copyFiles sources deliberately outside the hash. tiktoken's wasm lives under node_modules, so
   * it is untracked and `git ls-tree` has no blob to hash - MCP_VERSION does not move when it
   * changes. The entry may also simply be inert here: this handler's import graph does not reach
   * tiktoken (mcpCall.ts imports only @bike4mind/mcp, which esbuild treats as external), and it is
   * absent from the `install` list, so nothing resolves it at runtime either. Listing it records
   * that the exclusion is deliberate, not that it is harmless.
   *
   * An entry qualifies only if it sits under `node_modules`. Untracked alone is not enough: every
   * copied `<pkg>/dist` is gitignored too, so an untracked-only rule would let a workspace package
   * be exempted here - one line in a test file, no infra diff - rather than hashed. A dependency
   * artifact has no tracked source to hash; a workspace package always does.
   */
  const UNHASHED = ['apps/client/node_modules/tiktoken/tiktoken_bg.wasm'];

  /** Read lazily so a shape change fails as a test, not as a collection error. */
  let memo: { hashed: string[]; copied: string[]; declaration: string; hashConst: string } | undefined;
  const lists = () => {
    if (memo) return memo;
    const source = stripComments(read('infra/mcp.ts'));
    const declaration = balanced(
      source,
      soleMatch(source, /\bexport const mcpHandler\b/g, 'mcpHandler declaration').index,
      '{',
      '}'
    );
    const hashDecl = soleMatch(source, /\bconst\s+(\w+)\s*=\s*computeMcpContentHash\(/g, 'computeMcpContentHash call');
    const hashCall = balanced(source, hashDecl.index, '(', ')');
    const pathsList = balanced(
      hashCall,
      soleMatch(hashCall, /\bpaths:\s*\[/g, '`paths` list in the hash call').index,
      '[',
      ']'
    );
    const copyList = balanced(
      declaration,
      soleMatch(declaration, /\bcopyFiles:\s*\[/g, '`copyFiles` list on mcpHandler').index,
      '[',
      ']'
    );
    memo = {
      hashed: arrayLiterals(pathsList, '`paths`'),
      copied: copiedFrom(copyList),
      declaration,
      hashConst: hashDecl[1],
    };
    return memo;
  };

  it('reads a non-empty list from each side', () => {
    const { hashed, copied } = lists();
    expect(hashed.length, 'no paths extracted, so every comparison below would be vacuous').toBeGreaterThan(0);
    expect(copied.length, 'no copyFiles sources extracted, so every comparison below would be vacuous').toBeGreaterThan(
      0
    );
  });

  it('wires MCP_VERSION to the computed hash', () => {
    const { declaration, hashConst } = lists();
    expect(
      declaration,
      'MCP_VERSION is not set from the hash, so the lists below can agree perfectly while the mechanism they serve is defeated'
    ).toMatch(new RegExp(`MCP_VERSION:\\s*${hashConst}\\b`));
  });

  it('hashes every copied workspace package', () => {
    const { hashed, copied } = lists();
    expect(
      copied.filter(entry => !UNHASHED.includes(entry) && !coveringPath(entry, hashed)),
      'copied but not hashed: MCP_VERSION stays put while the bundle changes, so the Lambda serves previous code. ' +
        'Add the b4m-core/<pkg> prefix to the paths list in infra/mcp.ts.'
    ).toEqual([]);
  });

  it('copies every path it hashes', () => {
    const { hashed, copied } = lists();
    expect(
      hashed.filter(candidate => !copied.some(entry => coveringPath(entry, [candidate]))),
      'hashed but not copied: either the hash moves on code the bundle lacks, or a copyFiles entry was dropped'
    ).toEqual([]);
  });

  it('hashes a path git can actually see', () => {
    expect(
      lists().hashed.filter(entry => !tracked(entry)),
      'git ls-tree returns nothing here, so the path contributes no bytes and @bike4mind/infra throws on deploy'
    ).toEqual([]);
  });

  it('exempts only entries still copied, untracked, and outside the workspace source', () => {
    expect(
      UNHASHED.filter(entry => !lists().copied.includes(entry)),
      'stale allowlist entry'
    ).toEqual([]);
    expect(
      UNHASHED.filter(entry => tracked(entry) || !entry.includes('node_modules/')),
      'an exemption must be a dependency artifact under node_modules. A workspace path has tracked source that ' +
        'could be hashed instead, so allowlisting it would exempt real code from the guard.'
    ).toEqual([]);
  });
});

/**
 * Same obligation, weaker assertion. The help hash names its inputs inside call arguments - one
 * embedded in a `git ls-tree` command string - rather than as a list, so this checks only that
 * every copied source is named in the call, at a path boundary. The reverse direction has no list
 * to read and is left uncovered: narrowing the hash to a subdirectory of what copyFiles carries
 * would not be caught here.
 */
describe('HELP_CORPUS_VERSION names every source the help cron carries', () => {
  let memo: { hashCall: string; copied: string[]; declaration: string; hashConst: string } | undefined;
  const lists = () => {
    if (memo) return memo;
    const source = stripComments(read('infra/cron.ts'));
    const declaration = balanced(
      source,
      soleMatch(source, /\bconst helpDatalakeIngestCron\b/g, 'helpDatalakeIngestCron declaration').index,
      '{',
      '}'
    );
    const hashDecl = soleMatch(source, /\bconst\s+(\w+)\s*=\s*computeHelpCorpusHash\(/g, 'computeHelpCorpusHash call');
    const hashCall = balanced(source, hashDecl.index, '(', ')');
    const copyList = balanced(
      declaration,
      soleMatch(declaration, /\bcopyFiles:\s*\[/g, '`copyFiles` list on the help cron').index,
      '[',
      ']'
    );
    memo = { hashCall, copied: copiedFrom(copyList), declaration, hashConst: hashDecl[1] };
    return memo;
  };

  /** `docs-site/doc` is a substring of `docs-site/docs`, so containment alone would pass it. */
  const namedIn = (hashCall: string, entry: string) =>
    new RegExp(`${entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w./-])`).test(hashCall);

  it('reads a non-empty list of copied sources', () => {
    expect(
      lists().copied.length,
      'no copyFiles sources extracted, so the check below would be vacuous'
    ).toBeGreaterThan(0);
  });

  it('wires HELP_CORPUS_VERSION to the computed hash', () => {
    const { declaration, hashConst } = lists();
    expect(declaration, 'HELP_CORPUS_VERSION is not set from the hash, so the check below guards nothing').toMatch(
      new RegExp(`HELP_CORPUS_VERSION:\\s*${hashConst}\\b`)
    );
  });

  it('reads every copied source when computing the version', () => {
    const { hashCall, copied } = lists();
    expect(
      copied.filter(entry => !namedIn(hashCall, entry)),
      'copied but unread: HELP_CORPUS_VERSION stays put while the corpus changes, so the cron converges the lake onto stale docs'
    ).toEqual([]);
  });
});

/**
 * The scanner's own behaviour, pinned on synthetic sources. Everything above rests on it, and its
 * failure mode is a short read rather than a throw - exactly the quiet kind this file is about.
 */
describe('the source scanner', () => {
  it('reads comment text as prose, not as an opening quote', () => {
    expect(stripComments("// it is fine\nconst a = 'kept';")).toBe("\nconst a = 'kept';");
  });

  it('leaves a path containing // inside a string alone', () => {
    expect(stripComments("const u = 'http://localhost:3000';")).toBe("const u = 'http://localhost:3000';");
  });

  it('drops a block comment holding an unbalanced bracket', () => {
    expect(stripComments('/* see [1 */ const a = [];')).toBe(' const a = [];');
  });

  it('rejects an array holding anything but string literals', () => {
    expect(() => arrayLiterals("['a', ...REST]", '`paths`')).toThrow(/something other than string literals/);
    expect(arrayLiterals("['a', 'b']", '`paths`')).toEqual(['a', 'b']);
  });

  it('rejects a copyFiles entry whose source it cannot parse', () => {
    expect(() => copiedFrom("[{ from: DIST, to: 'x' }]")).toThrow(/1 `from:` keys but 0 parse/);
    expect(copiedFrom("[{ from: 'a', to: 'x' }, { from: \"b\", to: 'y' }]")).toEqual(['a', 'b']);
  });
});
