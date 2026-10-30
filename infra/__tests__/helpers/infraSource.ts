/**
 * Text-level readers for infra/ declarations. infra/ is an SST program and does not load outside
 * `sst`, so guards over it match the literals it evaluates. The scanner is pinned in
 * contentHashCoverage.test.ts.
 */

/**
 * Drops comments while leaving string literals intact, in one pass so an apostrophe in prose
 * ("it is") reads as comment text rather than opening a string. Neither file contains a regex
 * literal, which is the one construct this cannot tell from a division operator; the scanner's
 * own behaviour is pinned at the bottom of this file.
 */
export function stripComments(source: string): string {
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
export function soleMatch(source: string, anchor: RegExp, what: string): RegExpExecArray {
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
export function balanced(source: string, startIndex: number, open: string, close: string): string {
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
