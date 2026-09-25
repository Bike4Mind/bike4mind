// Copy of splitEquals in b4m-core/services/src/latticeService/intentScan.ts (see there for the
// scanner notes); the two must stay in sync.

const WHITESPACE = /\s/;
const EQUALS_OPS = ['=', 'equals', 'equal'];

function isLineTerminator(s: string, i: number): boolean {
  const c = s.charCodeAt(i);
  return c === 10 || c === 13 || c === 0x2028 || c === 0x2029;
}

/** `wsEnd[i]` ends the whitespace run at i (i itself when s[i] is not whitespace); `lineEnd[i]` is the next line terminator at or after i. */
interface ScanIndex {
  s: string;
  n: number;
  wsEnd: Int32Array;
  lineEnd: Int32Array;
  lastLineTerminator: number;
}

function indexText(s: string): ScanIndex {
  const n = s.length;
  const wsEnd = new Int32Array(n + 1);
  const lineEnd = new Int32Array(n + 1);
  wsEnd[n] = n;
  lineEnd[n] = n;
  let lastLineTerminator = -1;
  for (let i = n - 1; i >= 0; i--) {
    wsEnd[i] = WHITESPACE.test(s[i]) ? wsEnd[i + 1] : i;
    const lt = isLineTerminator(s, i);
    lineEnd[i] = lt ? i : lineEnd[i + 1];
    if (lt && lastLineTerminator < 0) lastLineTerminator = i;
  }
  return { s, n, wsEnd, lineEnd, lastLineTerminator };
}

/** Case-insensitive match of a lowercase ASCII `word` at i, as the `i` flag compares ASCII letters. */
function wordAt(s: string, i: number, word: string): boolean {
  if (i + word.length > s.length) return false;
  for (let j = 0; j < word.length; j++) {
    let c = s.charCodeAt(i + j);
    if (c >= 65 && c <= 90) c += 32;
    if (c !== word.charCodeAt(j)) return false;
  }
  return true;
}

/** `/^(.+?)\s*(?:=|equals?)\s*(.+)$/i` -> [output, expression]. */
export function splitEquals(s: string): [string, string] | null {
  const ix = indexText(s);
  const limit = Math.min(ix.lineEnd[0], ix.n - 1);
  let lastK = -1;
  for (let g = 1; g <= limit; g++) {
    const k = ix.wsEnd[g];
    if (k === lastK) continue;
    lastK = k;
    for (const op of EQUALS_OPS) {
      if (!wordAt(s, k, op)) continue;
      const p = k + op.length;
      const w = ix.wsEnd[p];
      let rest = -1;
      if (w < ix.n) rest = ix.lastLineTerminator < w ? w : -1;
      else if (ix.n - 1 >= p && !isLineTerminator(s, ix.n - 1)) rest = ix.n - 1;
      if (rest >= 0) return [s.slice(0, g), s.slice(rest)];
    }
  }
  return null;
}
