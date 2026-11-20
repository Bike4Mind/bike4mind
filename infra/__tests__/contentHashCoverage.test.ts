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
import { arrayLiterals, balanced, copiedFrom, soleMatch, stripComments } from './helpers/infraSource';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), 'utf8');

/** Whether git has any blob under `entry`, which is what decides if the hash can see it at all. */
const tracked = (entry: string) =>
  execFileSync('git', ['ls-tree', '-r', 'HEAD', entry], { cwd: REPO_ROOT, encoding: 'utf8' }).trim().length > 0;

/** The hashed path covering `source`, either exactly or as a parent directory. */
const coveringPath = (source: string, hashed: readonly string[]) =>
  hashed.find(candidate => source === candidate || source.startsWith(`${candidate}/`));

describe('MCP_VERSION covers every workspace package the MCP bundle carries', () => {
  /**
   * copyFiles sources deliberately outside the hash. Empty today: everything mcpHandler copies is a
   * workspace package with tracked source.
   *
   * An entry qualifies only if it sits under `node_modules`. Untracked alone is not enough: every
   * copied `<pkg>/dist` is gitignored too, so an untracked-only rule would let a workspace package
   * be exempted here - one line in a test file, no infra diff - rather than hashed. A dependency
   * artifact has no tracked source to hash; a workspace package always does.
   */
  const UNHASHED: string[] = [];

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
