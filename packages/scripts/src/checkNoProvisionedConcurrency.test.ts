import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Lambda provisioned concurrency stays out of `infra/`.
 *
 * SST attaches the allocation to a numbered version and creates no alias, while every caller
 * invokes by bare function name - which resolves to $LATEST. The warm capacity is therefore
 * unreachable: ProvisionedConcurrencyInvocations had zero datapoints in production on all three
 * functions that declared it, across a month of real traffic. It also leaks - each deploy
 * publishes a new version and attaches a fresh config without pruning the previous one, the
 * orphans count against `reservedConcurrentExecutions`, and once they saturate a function's
 * `reserved` budget the next deploy fails at the concurrency step with an error naming the wrong
 * resource. That has been cleaned up by hand twice.
 *
 * `reserved` is a different property - a real ceiling, unrelated to warm capacity - so the
 * positive assertions below keep it from being deleted along with the leak.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const INFRA_DIR = path.join(REPO_ROOT, 'infra');

const REMEDIATION =
  'Provisioned concurrency attaches to a numbered version that nothing invokes, and each deploy orphans ' +
  'the previous config until the leftovers saturate `reserved` and break the next deploy. Re-adding the ' +
  'flag on its own only recreates that leak - making warm capacity actually serve traffic takes an alias ' +
  'plus a `Qualifier` on every invoke site.';

const tsFilesUnder = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return tsFilesUnder(full);
    return entry.isFile() && entry.name.endsWith('.ts') ? [full] : [];
  });

/**
 * Blank out comments in place, preserving newlines, so match offsets still map to the original
 * file's line numbers. The explanatory notes on AgentExecutor, SlackQuestProcessor and mcpHandler
 * name provisioned concurrency on purpose and must not trip the check. Strings are left intact
 * (nothing here needs their contents) but are skipped so a `//` inside one is not read as a
 * comment; a lone backslash is skipped for the same reason, which is what keeps `\/` in a regex
 * literal from looking like the start of one.
 */
const stripComments = (source: string): string => {
  const out = source.split('');
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };

  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "'" || c === '`') {
      i++;
      while (i < source.length && source[i] !== c) i += source[i] === '\\' ? 2 : 1;
      i++;
    } else {
      i += c === '\\' ? 2 : 1;
    }
  }

  return out.join('');
};

// `\b` keeps this off `WARMER_CONCURRENCY:`; the lookahead keeps it off `==` and `=>`.
const CONCURRENCY_KEY = /\bconcurrency\s*\??\s*[:=](?![=>])/g;
const OPENERS = '{[(';
const CLOSERS = '}])';

/**
 * End of the value expression starting at `from`: the first `,`/`;`/unmatched closer at nesting
 * depth 0. Covers the flat object, the multi-line one, and the
 * `[...].includes($app.stage) ? { ... } : undefined` ternary every stage-gated block uses.
 */
const valueEnd = (code: string, from: number): number => {
  let depth = 0;
  for (let i = from; i < code.length; i++) {
    const c = code[i];
    if (OPENERS.includes(c)) depth++;
    else if (CLOSERS.includes(c)) {
      if (depth === 0) return i;
      depth--;
    } else if (depth === 0 && (c === ',' || c === ';')) return i;
  }
  return code.length;
};

const lineOf = (source: string, index: number): number => source.slice(0, index).split('\n').length;

interface Offence {
  file: string;
  line: number;
  text: string;
}

const scan = (file: string) => {
  const source = readFileSync(file, 'utf8');
  const code = stripComments(source);
  const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
  const lines = source.split('\n');

  const blocks: string[] = [];
  const offences: Offence[] = [];

  for (const match of code.matchAll(CONCURRENCY_KEY)) {
    const start = match.index + match[0].length;
    const end = valueEnd(code, start);
    const region = code.slice(start, end);
    blocks.push(region);

    const hit = /\bprovisioned\s*:/.exec(region);
    if (!hit) continue;
    const line = lineOf(code, start + hit.index);
    offences.push({ file: rel, line, text: lines[line - 1].trim() });
  }

  return { rel, blocks, offences };
};

/** Balanced-brace args of a named SST function, so `reserved` is checked on that resource only. */
const functionArgs = (code: string, name: string): string => {
  const marker = `new sst.aws.Function('${name}'`;
  const at = code.indexOf(marker);
  if (at === -1) return '';
  const open = code.indexOf('{', at + marker.length);
  if (open === -1) return '';

  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (OPENERS.includes(code[i])) depth++;
    else if (CLOSERS.includes(code[i])) {
      depth--;
      if (depth === 0) return code.slice(open, i + 1);
    }
  }
  return '';
};

const scanned = tsFilesUnder(INFRA_DIR).map(scan);

describe('infra declares no Lambda provisioned concurrency', () => {
  it('parses concurrency blocks in the files known to declare them, proving the scan is not vacuous', () => {
    const withBlocks = scanned.filter(s => s.blocks.length > 0).map(s => s.rel);

    expect(withBlocks).toEqual(
      expect.arrayContaining([
        'infra/agentExecutor.ts',
        'infra/functions.ts',
        'infra/queues.ts',
        'infra/subscriberFanout.ts',
      ])
    );
  });

  it('has no `provisioned` key inside a concurrency block', () => {
    const offences = scanned.flatMap(s => s.offences);

    expect(
      offences.map(o => `${o.file}:${o.line}  ${o.text}`),
      REMEDIATION
    ).toEqual([]);
  });

  it.each([
    ['infra/agentExecutor.ts', 'AgentExecutor'],
    ['infra/functions.ts', 'SlackQuestProcessor'],
  ])('keeps `reserved` on %s (%s)', (file, name) => {
    const args = functionArgs(stripComments(readFileSync(path.join(REPO_ROOT, file), 'utf8')), name);

    expect(args, `${name} was not found in ${file} - update this guard if the resource was renamed.`).not.toBe('');
    expect(
      /\breserved\s*:/.test(args),
      `${name} lost its \`reserved\` ceiling. That is a concurrency cap, not warm capacity, and is unrelated to the provisioned-concurrency leak - do not drop it while removing that.`
    ).toBe(true);
  });
});
