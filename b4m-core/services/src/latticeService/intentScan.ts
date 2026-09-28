// Hand scanners for the lattice rule-parser patterns. Each returns the same captures as the
// regex in its doc comment, but in linear time: those regexes backtracked quadratically or
// worse on runs of whitespace or operators. `.` there excludes line terminators and `\s`
// spans them, which is why the scanners track both. splitEquals has a copy in
// apps/client/app/utils/splitEquals.ts.

const WHITESPACE = /\s/;
const OPERATORS = '+-*/';
const EQUALS_OPS = ['=', 'equals', 'equal'];
const SET_OPS = ['is', 'to', '=', 'equals', 'equal'];

function isLineTerminator(s: string, i: number): boolean {
  const c = s.charCodeAt(i);
  return c === 10 || c === 13 || c === 0x2028 || c === 0x2029;
}

const isDigit = (s: string, i: number) => {
  const c = s.charCodeAt(i);
  return c >= 48 && c <= 57;
};

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

const isWs = (ix: ScanIndex, i: number) => i < ix.n && ix.wsEnd[i] !== i;

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

/**
 * For each g, the first g' >= g where the group can end, given `accept(k)` for the run end k
 * that g reaches. Every g inside a whitespace run shares k, so accept runs once per run.
 * `needsWs` is for a pattern whose group is followed by `\s+` rather than `\s*`.
 */
function nextAccepted(ix: ScanIndex, needsWs: boolean, accept: (k: number) => boolean): Int32Array {
  const next = new Int32Array(ix.n + 2).fill(ix.n + 1);
  let lastK = -1;
  let lastOk = false;
  for (let g = ix.n - 1; g >= 0; g--) {
    const k = ix.wsEnd[g];
    if (k !== lastK) {
      lastK = k;
      lastOk = accept(k);
    }
    next[g] = lastOk && (!needsWs || k !== g) ? g : next[g + 1];
  }
  return next;
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

/** The amount group of `\s+(?:is|to|=|equals?)\s+\$?([\d,]+(?:\.\d+)?)` with the operator at k. */
function amountAt(ix: ScanIndex, k: number): string | null {
  const { s, n } = ix;
  for (const op of SET_OPS) {
    if (!wordAt(s, k, op) || !isWs(ix, k + op.length)) continue;
    const v = ix.wsEnd[k + op.length];
    const u = s[v] === '$' ? v + 1 : v;
    let e = u;
    while (e < n && (isDigit(s, e) || s[e] === ',')) e++;
    if (e === u) continue;
    if (s[e] === '.' && isDigit(s, e + 1)) {
      e++;
      while (e < n && isDigit(s, e)) e++;
    }
    return s.slice(u, e);
  }
  return null;
}

/** `/(?:set\s+)?(.+?)\s+(?:is|to|=|equals?)\s+\$?([\d,]+(?:\.\d+)?)/i` (unanchored) -> [entity, amount]. */
export function matchSetValue(s: string): [string, string] | null {
  const ix = indexText(s);
  const next = nextAccepted(ix, true, k => amountAt(ix, k) !== null);
  const groupEnd = (c: number) => {
    if (c >= ix.n) return -1;
    const g = next[c + 1];
    return g <= ix.lineEnd[c] && g < ix.n ? g : -1;
  };
  for (let st = 0; st < ix.n; st++) {
    if (wordAt(s, st, 'set') && isWs(ix, st + 3)) {
      const c = ix.wsEnd[st + 3];
      const g = groupEnd(c);
      if (g >= 0) return [s.slice(c, g), amountAt(ix, ix.wsEnd[g])!];
      // Backtracking into the run after `set`: a one-character whitespace entity.
      for (let c0 = c - 2; c0 >= st + 4; c0--) {
        if (isLineTerminator(s, c0)) continue;
        const amount = amountAt(ix, c);
        if (amount !== null) return [s[c0], amount];
        break;
      }
    }
    const g = groupEnd(st);
    if (g >= 0) return [s.slice(st, g), amountAt(ix, ix.wsEnd[g])!];
  }
  return null;
}

/** `\s*(.+)` at q, unanchored: the rest of the line after the operator. */
function lastOperand(ix: ScanIndex, q: number): string | null {
  const v = ix.wsEnd[q];
  if (v < ix.n) return ix.s.slice(v, ix.lineEnd[v]);
  for (let i = ix.n - 1; i >= q; i--) {
    if (!isLineTerminator(ix.s, i)) return ix.s.slice(i, ix.lineEnd[i]);
  }
  return null;
}

/** `/(.+?)\s*(?:=|equals?)\s*(.+?)\s*([+\-*\/])\s*(.+)/i` (unanchored) -> [output, left, operator, right]. */
export function matchFormula(s: string): [string, string, string, string] | null {
  const ix = indexText(s);
  const { n } = ix;
  const nextOp = new Int32Array(n + 2).fill(n);
  const runStart = new Int32Array(n + 1);
  for (let i = n - 1; i >= 0; i--) nextOp[i] = OPERATORS.includes(s[i]) ? i : nextOp[i + 1];
  for (let i = 0; i < n; i++) runStart[i] = i > 0 && isWs(ix, i) && isWs(ix, i - 1) ? runStart[i - 1] : i;

  const operandsAt = (p: number): [string, string, string] | null => {
    const w = ix.wsEnd[p];
    if (w >= n) return null;
    const o = nextOp[w + 1];
    if (o < n) {
      const h = o - 1 >= w + 1 && isWs(ix, o - 1) ? Math.max(runStart[o - 1], w + 1) : o;
      const right = h <= ix.lineEnd[w] ? lastOperand(ix, o + 1) : null;
      if (right !== null) return [s.slice(w, h), s[o], right];
    }
    // Backtracking into the run before the left operand: a one-character whitespace operand.
    if (w > p && OPERATORS.includes(s[w])) {
      for (let g0 = w - 1; g0 >= p; g0--) {
        if (isLineTerminator(s, g0)) continue;
        const right = lastOperand(ix, w + 1);
        return right === null ? null : [s[g0], s[w], right];
      }
    }
    return null;
  };
  const formulaAt = (k: number) => {
    for (const op of EQUALS_OPS) {
      const operands = wordAt(s, k, op) ? operandsAt(k + op.length) : null;
      if (operands) return operands;
    }
    return null;
  };

  const next = nextAccepted(ix, false, k => formulaAt(k) !== null);
  for (let st = 0; st < n; st++) {
    const g = next[st + 1];
    if (g <= ix.lineEnd[st] && g < n) return [s.slice(st, g), ...formulaAt(ix.wsEnd[g])!];
  }
  return null;
}

/** `/(?:explain|how\s+is)\s+(.+?)(?:\s+calculated)?(?:\?)?$/i` (unanchored) -> [entity]. */
export function matchExplain(s: string): [string] | null {
  const ix = indexText(s);
  const { n } = ix;
  const question = s[n - 1] === '?';
  // The only span where the optional `\s+calculated` suffix can start and still reach the end.
  const k = n - 10 - (question ? 1 : 0);
  let suffixFrom = -1;
  if (k >= 1 && wordAt(s, k, 'calculated') && isWs(ix, k - 1)) {
    suffixFrom = k - 1;
    while (suffixFrom > 0 && isWs(ix, suffixFrom - 1)) suffixFrom--;
  }
  const firstEnd = (x: number) => {
    if (suffixFrom >= 0 && x < k) return Math.max(x, suffixFrom);
    if (question && x <= n - 1) return n - 1;
    return x <= n ? n : -1;
  };
  for (let st = 0; st < n; st++) {
    let a = -1;
    if (wordAt(s, st, 'explain')) a = st + 7;
    else if (wordAt(s, st, 'how') && isWs(ix, st + 3) && wordAt(s, ix.wsEnd[st + 3], 'is')) a = ix.wsEnd[st + 3] + 2;
    if (a < 0 || !isWs(ix, a)) continue;
    for (let g0 = ix.wsEnd[a]; g0 > a; g0--) {
      const g1 = firstEnd(g0 + 1);
      if (g1 >= 0 && g1 <= ix.lineEnd[g0]) return [s.slice(g0, g1)];
    }
  }
  return null;
}
